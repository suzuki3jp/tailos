import { DurableObject } from 'cloudflare:workers';
import { CodexDeviceAuth, ReauthenticationRequired, type CodexCredentials } from '../adapters/auth/codex-device';
import type { DeviceChallenge } from '../core/ports';
import type { AccessGrant } from '../contracts/index';
import { safeError } from '../security';
import { seal, unseal, type Sealed } from './sealed-store';
import type { Env } from './env';

interface StoredConnection { version: string; sealed: Sealed }
interface Pending { challenge: DeviceChallenge; failures: number }
export interface ConnectionStatus {
  state: 'disconnected' | 'pending' | 'connected' | 'reauth_required';
  email?: string; planType?: string; error?: string;
  challenge?: { userCode: string; verificationUrl: string; expiresAt: number };
}
export class CredentialBroker extends DurableObject<Env> {
  private adapter = new CodexDeviceAuth();
  private serial<T>(action: () => Promise<T>): Promise<T> { return this.ctx.blockConcurrencyWhile(action); }
  private async readConnection(): Promise<{ stored: StoredConnection; tokens: CodexCredentials } | undefined> {
    const stored = await this.ctx.storage.get<StoredConnection>('connection');
    if (!stored) return;
    return { stored, tokens: await unseal(stored.sealed, this.env.CREDENTIAL_ENCRYPTION_KEY, `codex:${stored.version}`) };
  }
  private async writeConnection(tokens: CodexCredentials, version: string): Promise<void> {
    await this.ctx.storage.put('connection', { version, sealed: await seal(tokens, this.env.CREDENTIAL_ENCRYPTION_KEY, `codex:${version}`) });
    await this.ctx.storage.put('status', { state: 'connected', email: tokens.email, planType: tokens.planType } satisfies ConnectionStatus);
  }
  async status(): Promise<ConnectionStatus> {
    return this.serial(async () => {
      const status = await this.ctx.storage.get<ConnectionStatus>('status') ?? { state: 'disconnected' as const };
      const sealed = await this.ctx.storage.get<Sealed>('pending');
      if (!sealed) return status;
      const { challenge } = await unseal<Pending>(sealed, this.env.CREDENTIAL_ENCRYPTION_KEY, 'codex:pending');
      if (challenge.expiresAt <= Date.now()) return { ...status, error: 'Connection code expired. Start again.' };
      return { ...status, state: 'pending', challenge: { userCode: challenge.userCode, verificationUrl: challenge.verificationUrl, expiresAt: challenge.expiresAt } };
    });
  }
  async begin(): Promise<void> {
    return this.serial(async () => {
      const sealed = await this.ctx.storage.get<Sealed>('pending');
      if (sealed) {
        const pending = await unseal<Pending>(sealed, this.env.CREDENTIAL_ENCRYPTION_KEY, 'codex:pending');
        if (pending.challenge.expiresAt > Date.now()) return;
      }
      const lastStart = await this.ctx.storage.get<number>('lastStart') ?? 0;
      if (Date.now() - lastStart < 30_000) throw new Error('Wait a moment before starting another connection');
      const challenge = await this.adapter.begin();
      await this.ctx.storage.put({ pending: await seal({ challenge, failures: 0 }, this.env.CREDENTIAL_ENCRYPTION_KEY, 'codex:pending'), lastStart: Date.now() });
      await this.ctx.storage.setAlarm(Date.now() + challenge.intervalSeconds * 1000);
    });
  }
  async disconnect(): Promise<void> {
    return this.serial(async () => {
      await this.ctx.storage.delete(['connection', 'pending']);
      await this.ctx.storage.put('status', { state: 'disconnected' });
      await this.ctx.storage.deleteAlarm();
    });
  }
  async acquire(connectionId = 'default', version?: string, force = false): Promise<AccessGrant> {
    return this.serial(() => this.acquireLocked(connectionId, version, force));
  }
  private async acquireLocked(connectionId: string, version?: string, force = false): Promise<AccessGrant> {
    if (connectionId !== 'default') throw new Error('Unknown connection');
    const connection = await this.readConnection();
    if (!connection || (version && connection.stored.version !== version)) throw new Error('ChatGPT connection is unavailable or was replaced');
    let { tokens } = connection;
    if (force || tokens.expiresAt < Date.now() + 5 * 60_000) {
      try {
        tokens = await this.adapter.refresh(tokens);
        // One Durable Object owns the rotating refresh token. Save the pair before returning access.
        await this.writeConnection(tokens, connection.stored.version);
      } catch (error) {
        if (error instanceof ReauthenticationRequired) {
          await this.ctx.storage.delete('connection');
          await this.ctx.storage.put('status', { state: 'reauth_required', error: error.message });
        }
        throw error;
      }
    }
    if (!await this.ctx.storage.get('pending')) await this.ctx.storage.setAlarm(Math.max(Date.now() + 60_000, tokens.expiresAt - 5 * 60_000));
    return { accessToken: tokens.accessToken, accountId: tokens.accountId, planType: tokens.planType,
      expiresAt: tokens.expiresAt, connectionVersion: connection.stored.version };
  }
  async alarm(): Promise<void> {
    await this.serial(async () => {
      const sealed = await this.ctx.storage.get<Sealed>('pending');
      if (sealed) {
        const pending = await unseal<Pending>(sealed, this.env.CREDENTIAL_ENCRYPTION_KEY, 'codex:pending');
        try {
          if (pending.challenge.expiresAt <= Date.now()) throw new Error('Connection code expired. Start again.');
          const tokens = await this.adapter.complete(pending.challenge);
          if (tokens) {
            await this.writeConnection(tokens, crypto.randomUUID());
            await this.ctx.storage.delete('pending');
            await this.ctx.storage.setAlarm(Math.max(Date.now() + 60_000, tokens.expiresAt - 5 * 60_000));
            return;
          }
          pending.failures = 0;
        } catch (error) {
          pending.failures++;
          if (pending.failures >= 5 || pending.challenge.expiresAt <= Date.now()) {
            await this.ctx.storage.delete('pending');
            const status = await this.ctx.storage.get<ConnectionStatus>('status') ?? { state: 'disconnected' as const };
            await this.ctx.storage.put('status', { ...status, error: safeError(error) });
            if (await this.ctx.storage.get('connection')) await this.ctx.storage.setAlarm(Date.now() + 60_000);
            return;
          }
        }
        await this.ctx.storage.put('pending', await seal(pending, this.env.CREDENTIAL_ENCRYPTION_KEY, 'codex:pending'));
        await this.ctx.storage.setAlarm(Date.now() + Math.max(pending.challenge.intervalSeconds, pending.failures * 10) * 1000);
      } else if (await this.ctx.storage.get('connection')) {
        try { await this.acquireLocked('default', undefined, true); }
        catch (error) {
          console.error(JSON.stringify({ event: 'auth.refresh_failed', message: safeError(error) }));
          if (await this.ctx.storage.get('connection')) await this.ctx.storage.setAlarm(Date.now() + 60_000);
        }
      }
    });
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../src/cloudflare/credential-broker';
import { CodexDeviceAuth, type CodexCredentials } from '../src/adapters/auth/codex-device';
import { seal, unseal } from '../src/cloudflare/sealed-store';
import { memoryState } from './helpers/cloudflare';
const key = Buffer.alloc(32, 7).toString('base64');
const tokens: CodexCredentials = { accessToken: 'old-access', refreshToken: 'old-refresh', idToken: 'id', accountId: 'account', expiresAt: 1 };
afterEach(() => vi.restoreAllMocks());
describe('cloud credential ownership', () => {
  it('encrypts credentials with authentication and context binding', async () => {
    const encrypted = await seal(tokens, key, 'connection-a');
    expect(JSON.stringify(encrypted)).not.toContain('old-refresh');
    expect(await unseal(encrypted, key, 'connection-a')).toEqual(tokens);
    await expect(unseal(encrypted, key, 'connection-b')).rejects.toThrow();
    await expect(unseal({ ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -4) + 'AAAA' }, key, 'connection-a')).rejects.toThrow();
  });
  it('serializes simultaneous refresh requests and saves the rotated pair', async () => {
    const state = memoryState();
    await state.storage.put('connection', { version: 'v1', sealed: await seal(tokens, key, 'codex:v1') });
    const refresh = vi.spyOn(CodexDeviceAuth.prototype, 'refresh').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { ...tokens, accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 3_600_000 };
    });
    const broker = new CredentialBroker(state as any, { CREDENTIAL_ENCRYPTION_KEY: key } as any);
    const [a, b] = await Promise.all([broker.acquire('default'), broker.acquire('default')]);
    expect(refresh).toHaveBeenCalledTimes(1); expect(a).toEqual(b);
    expect(a.accessToken).toBe('new-access'); expect(a).not.toHaveProperty('refreshToken');
    const stored = state.map.get('connection');
    expect((await unseal<CodexCredentials>(stored.sealed, key, 'codex:v1')).refreshToken).toBe('new-refresh');
    expect(await broker.status()).not.toHaveProperty('accessToken');
    await broker.disconnect(); await expect(broker.acquire('default', 'v1')).rejects.toThrow('unavailable');
  });
});

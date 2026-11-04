import { createRemoteJWKSet, jwtVerify, decodeJwt, customFetch } from 'jose';
import type { AuthAdapter, AuthChallenge, DeviceChallenge } from '../../core/ports';

// Isolated compatibility surface, based on the Codex device login implementation.
// This is Codex OAuth, not the identity-only SIWC website flow.
const issuer = 'https://auth.openai.com';
const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
export class ReauthenticationRequired extends Error {}
export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  email?: string;
  planType?: string;
  expiresAt: number;
}

export class CodexDeviceAuth implements AuthAdapter<CodexCredentials> {
  readonly id = 'codex';
  private jwks: ReturnType<typeof createRemoteJWKSet>;
  constructor(private readonly http: typeof fetch = fetch) {
    this.jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { [customFetch]: http });
  }
  private async post(path: string, body: unknown, form = false): Promise<Response> {
    return this.http(`${issuer}${path}`, {
      method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
      signal: AbortSignal.timeout(7_000),
    });
  }
  async begin(): Promise<DeviceChallenge> {
    const response = await this.post('/api/accounts/deviceauth/usercode', { client_id: clientId });
    if (!response.ok) throw new Error(`Could not start ChatGPT connection (${response.status})`);
    const data = await response.json() as Record<string, unknown>;
    const userCode = data.user_code ?? data.usercode;
    if (typeof userCode !== 'string' || typeof data.device_auth_id !== 'string') throw new Error('Invalid device authorization response');
    return { kind: 'device', userCode, verificationUrl: `${issuer}/codex/device`,
      intervalSeconds: Math.max(5, Number(data.interval) || 5), expiresAt: Date.now() + 15 * 60_000,
      opaque: data.device_auth_id };
  }
  async complete(challenge: AuthChallenge): Promise<CodexCredentials | null> {
    if (challenge.kind !== 'device') throw new Error('Codex device adapter requires a device challenge');
    const response = await this.post('/api/accounts/deviceauth/token', { device_auth_id: challenge.opaque, user_code: challenge.userCode });
    if ([403, 404].includes(response.status)) return null;
    if (!response.ok) throw new Error(`ChatGPT connection failed (${response.status})`);
    const data = await response.json() as Record<string, string>;
    if (!data.authorization_code || !data.code_verifier) throw new Error('Invalid device authorization response');
    const tokens = await this.post('/oauth/token', { grant_type: 'authorization_code', client_id: clientId,
      code: data.authorization_code, code_verifier: data.code_verifier, redirect_uri: `${issuer}/deviceauth/callback` }, true);
    if (!tokens.ok) throw new Error(`ChatGPT token exchange failed (${tokens.status})`);
    return this.validate(await tokens.json());
  }
  async refresh(previous: CodexCredentials): Promise<CodexCredentials> {
    const response = await this.post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: previous.refreshToken });
    if ([400, 401, 403].includes(response.status)) throw new ReauthenticationRequired('Reconnect your ChatGPT account');
    if (!response.ok) throw new Error(`ChatGPT token refresh failed (${response.status})`);
    return this.validate(await response.json(), previous);
  }
  private async validate(value: unknown, previous?: CodexCredentials): Promise<CodexCredentials> {
    const data = value as Record<string, unknown>;
    if (typeof data.access_token !== 'string') throw new Error('No access token in ChatGPT response');
    const idToken = typeof data.id_token === 'string' ? data.id_token : previous?.idToken;
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : previous?.refreshToken;
    if (!idToken || !refreshToken) throw new Error('Incomplete ChatGPT credentials');
    // A retained, previously validated ID token can outlive its access token.
    const claims = data.id_token ? (await jwtVerify(idToken, this.jwks, { issuer, audience: clientId })).payload : decodeJwt(idToken);
    const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    const accountId = auth?.chatgpt_account_id;
    if (typeof accountId !== 'string') throw new Error('ChatGPT account ID is missing');
    if (previous && previous.accountId !== accountId) throw new Error('ChatGPT account changed during refresh');
    const accessClaims = decodeJwt(data.access_token);
    const expiresAt = Number(accessClaims.exp) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid access token expiration');
    return { accessToken: data.access_token, refreshToken, idToken, accountId, expiresAt,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      planType: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined };
  }
}

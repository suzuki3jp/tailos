import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { CodexDeviceAuth, ReauthenticationRequired } from '../src/adapters/auth/codex-device';
describe('Codex OAuth compatibility adapter', () => {
  it('completes device authorization with verified identity and supports rotating refresh tokens', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const jwt = await new SignJWT({ email: 'owner@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'account', chatgpt_plan_type: 'plus' } })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com')
      .setAudience('app_EMoamEEZ73f0CkXaXp7hrann').setExpirationTime('1h').sign(privateKey);
    const calls: { path: string; body: string }[] = [];
    let poll = 0;
    const http: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, body: String(init?.body ?? '') });
      if (path.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
      if (path.endsWith('/usercode')) return Response.json({ user_code: 'ABCD-1234', device_auth_id: 'opaque-device-id', interval: '5' });
      if (path.endsWith('/deviceauth/token')) return ++poll === 1 ? new Response(null, { status: 403 }) : Response.json({ authorization_code: 'code', code_verifier: 'verifier' });
      if (String(init?.body).includes('refresh_token')) return Response.json({ access_token: jwt, refresh_token: 'rotated-refresh' });
      return Response.json({ access_token: jwt, refresh_token: 'initial-refresh', id_token: jwt });
    };
    const adapter = new CodexDeviceAuth(http), challenge = await adapter.begin();
    expect(challenge.userCode).toBe('ABCD-1234');
    expect(await adapter.complete(challenge)).toBeNull();
    const tokens = await adapter.complete(challenge);
    expect(tokens?.accountId).toBe('account'); expect(tokens?.email).toBe('owner@example.test');
    const rotated = await adapter.refresh(tokens!); expect(rotated.refreshToken).toBe('rotated-refresh');
    const exchange = calls.find(c => c.body.includes('authorization_code'))!;
    expect(new URLSearchParams(exchange.body).get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
    expect(JSON.parse(calls.at(-1)!.body).grant_type).toBe('refresh_token');
  });
  it('requires reconnect after a rejected refresh and does not expose the provider response', async () => {
    const adapter = new CodexDeviceAuth(async () => new Response('sensitive-provider-body', { status: 401 }));
    await expect(adapter.refresh({ accessToken: 'a', refreshToken: 'r', idToken: 'i', accountId: 'x', expiresAt: 1 })).rejects.toBeInstanceOf(ReauthenticationRequired);
  });
});

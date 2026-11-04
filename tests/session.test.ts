import { expect, it } from 'vitest';
import { checkOrigin, isOwner, issueSession } from '../src/cloudflare/session';
import { redact, readLimitedText } from '../src/security';
it('accepts signed owner sessions and rejects tampered cookies and cross-origin mutations', async () => {
  const secret = 'a'.repeat(32); const token = await issueSession(secret);
  const request = (value: string) => new Request('https://meguri.test', { headers: { Cookie: `meguri_session=${value}`, Origin: 'https://attacker.test' } });
  expect(await isOwner(request(token), secret)).toBe(true);
  expect(await isOwner(request(token.slice(0, -5) + 'aaaaa'), secret)).toBe(false);
  expect(checkOrigin(request(token), 'https://meguri.test')).toBe(false);
});
it('redacts credential fields, tokens embedded in text, and known secrets', async () => {
  const value = redact({ refreshToken: 'refresh', nested: ['Bearer abcdef', 'access-is-very-secret'] }, ['access-is-very-secret']);
  expect(JSON.stringify(value)).not.toMatch(/refresh"|abcdef|access-is-very-secret/);
  await expect(readLimitedText(new Request('https://meguri.test', { method: 'POST', body: '123456' }), 5)).rejects.toThrow('too large');
});

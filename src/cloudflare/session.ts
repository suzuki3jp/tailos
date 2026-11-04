import { jwtVerify, SignJWT } from 'jose';
export const sessionCookie = 'meguri_session';
export async function issueSession(secret: string): Promise<string> {
  if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  return new SignJWT({ role: 'owner' }).setProtectedHeader({ alg: 'HS256' }).setIssuer('meguri').setAudience('meguri-admin')
    .setIssuedAt().setExpirationTime('12h').sign(new TextEncoder().encode(secret));
}
export async function isOwner(request: Request, secret: string): Promise<boolean> {
  const cookie = request.headers.get('Cookie')?.split(';').map(c => c.trim()).find(c => c.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1);
  if (!cookie || !secret || secret.length < 32) return false;
  try {
    const verified = await jwtVerify(cookie, new TextEncoder().encode(secret), { algorithms: ['HS256'], issuer: 'meguri', audience: 'meguri-admin' });
    return verified.payload.role === 'owner';
  } catch { return false; }
}
export function checkOrigin(request: Request, origin: string): boolean {
  return request.headers.get('Origin') === new URL(origin).origin;
}

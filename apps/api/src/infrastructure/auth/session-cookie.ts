import { makeSignature } from "better-auth/crypto";
import type { createLoginAuth } from "./login.ts";

export async function createLoginSessionCookie(
  auth: NonNullable<ReturnType<typeof createLoginAuth>>,
  userId: string,
) {
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId);
  const signature = await makeSignature(session.token, context.secret);
  return {
    ...context.authCookies.sessionToken,
    value: encodeURIComponent(`${session.token}.${signature}`),
    expiresAt: session.expiresAt,
  };
}

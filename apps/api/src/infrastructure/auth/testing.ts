import { assert } from "vitest";
import { makeSignature } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/d1";
import { authAccounts, users } from "#api/infrastructure/d1/schema.ts";
import type { Bindings } from "#api/bindings.ts";
import { createLoginAuth } from "#api/infrastructure/auth/login.ts";

export function testLoginBindings(DB: Bindings["DB"]) {
  return {
    DB,
    TAILOS_PUBLIC_ORIGIN: "https://api.tailos.example",
    TAILOS_WEB_ORIGIN: "https://tailos.example",
    BETTER_AUTH_SECRET: "test-only-47-characters-of-random-looking-value",
    TAILOS_GITHUB_OAUTH_CLIENT_ID: "test-client",
    TAILOS_GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    TAILOS_OPERATOR_GITHUB_ID: "123",
  };
}

export async function createTestOperator(
  env: ReturnType<typeof testLoginBindings>,
) {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = new Date();
  await db.batch([
    db.insert(users).values({
      id,
      name: "Operator",
      email: "operator@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(authAccounts).values({
      id: crypto.randomUUID(),
      userId: id,
      providerId: "github",
      accountId: env.TAILOS_OPERATOR_GITHUB_ID,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  const auth = createLoginAuth(env);
  assert(auth);
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(id);
  const signature = await makeSignature(session.token, context.secret);
  return {
    id,
    cookie:
      context.authCookies.sessionToken.name +
      "=" +
      encodeURIComponent(session.token + "." + signature),
  };
}

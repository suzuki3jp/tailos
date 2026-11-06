import { assert } from "vitest";
import { makeSignature } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/d1";
import { authAccounts, users } from "../d1/schema.ts";
import type { Bindings } from "../../bindings.ts";
import { createLoginAuth } from "./login.ts";

export function testLoginBindings(DB: Bindings["DB"]) {
  return {
    DB,
    MEGURI_PUBLIC_ORIGIN: "https://meguri.example",
    BETTER_AUTH_SECRET: "test-only-47-characters-of-random-looking-value",
    MEGURI_GITHUB_OAUTH_CLIENT_ID: "test-client",
    MEGURI_GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    MEGURI_OPERATOR_GITHUB_ID: "123",
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
      accountId: env.MEGURI_OPERATOR_GITHUB_ID,
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

import { assert } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { authAccounts, users } from "@/infrastructure/d1/schema.ts";
import type { Bindings } from "@/bindings.ts";
import { createLoginAuth } from "@/infrastructure/auth/login.ts";
import { createLoginSessionCookie } from "./session-cookie.ts";

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
  const { name, value } = await createLoginSessionCookie(auth, id);
  return { id, cookie: `${name}=${value}` };
}

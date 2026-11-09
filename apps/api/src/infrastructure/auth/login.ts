import type { LoginAuth } from "../../application/auth/login.ts";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { github } from "better-auth/social-providers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  authAccounts,
  authVerifications,
  loginSessions,
  users,
} from "../d1/schema.ts";
import type { Bindings } from "../../bindings.ts";

const providerId = "github";
const authPath = "/api/auth";
const loginPath = "/login";

export function createLoginAuth(env: Bindings) {
  const origin = env.MEGURI_PUBLIC_ORIGIN;
  const webOrigin = env.MEGURI_WEB_ORIGIN;
  const secret = env.BETTER_AUTH_SECRET;
  const clientId = env.MEGURI_GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.MEGURI_GITHUB_OAUTH_CLIENT_SECRET;
  const githubId = env.MEGURI_OPERATOR_GITHUB_ID;
  if (
    !origin ||
    !webOrigin ||
    !secret ||
    !clientId ||
    !clientSecret ||
    !githubId
  )
    return null;

  const provider = github({ clientId, clientSecret });
  return betterAuth({
    baseURL: origin,
    basePath: authPath,
    trustedOrigins: [webOrigin],
    secret,
    database: drizzleAdapter(drizzle(env.DB), {
      provider: "sqlite",
      schema: {
        user: users,
        account: authAccounts,
        session: loginSessions,
        verification: authVerifications,
      },
    }),
    advanced: { database: { generateId: "uuid" } },
    telemetry: { enabled: false },
    session: { disableSessionRefresh: true },
    socialProviders: {
      github: {
        clientId,
        clientSecret,
        async getUserInfo(tokens) {
          const info = await provider.getUserInfo(tokens);
          if (!info || String(info.data.id) !== githubId) return null;
          return info;
        },
      },
    },
    account: {
      accountLinking: { enabled: false },
      updateAccountOnSignIn: false,
    },
    databaseHooks: {
      account: {
        create: {
          async before(account) {
            return {
              data: {
                ...account,
                accessToken: null,
                refreshToken: null,
                idToken: null,
                accessTokenExpiresAt: null,
                refreshTokenExpiresAt: null,
              },
            };
          },
        },
      },
    },
    onAPIError: { errorURL: new URL(loginPath, webOrigin).href },
  });
}

export async function findOperatorUserId(env: Bindings) {
  const githubId = env.MEGURI_OPERATOR_GITHUB_ID;
  if (!githubId) return null;
  const [account] = await drizzle(env.DB)
    .select({ userId: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, providerId),
        eq(authAccounts.accountId, githubId),
      ),
    );
  return account?.userId ?? null;
}

export async function getOperatorSession(
  env: Bindings,
  headers: Headers,
  auth: Pick<LoginAuth, "api"> | null = createLoginAuth(env),
) {
  if (!auth) return null;
  const session = await auth.api.getSession({ headers });
  if (!session || session.user.id !== (await findOperatorUserId(env)))
    return null;
  return session;
}

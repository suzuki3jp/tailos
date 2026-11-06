import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { github } from "better-auth/social-providers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { jsx } from "hono/jsx";
import {
  authAccounts,
  authVerifications,
  loginSessions,
  users,
} from "../db/schema.ts";
import type { Bindings } from "../internal.ts";

const providerId = "github";
const authPath = "/api/auth";
const loginPath = "/login";

export function createLoginAuth(env: Bindings) {
  const origin = env.MEGURI_PUBLIC_ORIGIN;
  const secret = env.BETTER_AUTH_SECRET;
  const clientId = env.MEGURI_GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.MEGURI_GITHUB_OAUTH_CLIENT_SECRET;
  const githubId = env.MEGURI_OPERATOR_GITHUB_ID;
  if (!origin || !secret || !clientId || !clientSecret || !githubId)
    return null;

  const provider = github({ clientId, clientSecret });
  return betterAuth({
    baseURL: origin,
    basePath: authPath,
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
    onAPIError: { errorURL: new URL(loginPath, origin).href },
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
  auth = createLoginAuth(env),
) {
  if (!auth) return null;
  const session = await auth.api.getSession({ headers });
  if (!session || session.user.id !== (await findOperatorUserId(env)))
    return null;
  return session;
}

export const loginRoutes = new Hono<{ Bindings: Bindings }>();

const loginOrigin = createMiddleware<{ Bindings: Bindings }>(
  async (c, next) => {
    const origin = c.env?.MEGURI_PUBLIC_ORIGIN;
    if (!origin || new URL(c.req.url).origin !== origin) return c.notFound();
    if (c.req.method === "POST" && c.req.header("Origin") !== origin)
      return c.text("Forbidden", 403);
    await next();
    c.header("Cache-Control", "private, no-store");
  },
);

loginRoutes.get(loginPath, loginOrigin, async (c) => {
  const auth = createLoginAuth(c.env);
  if (!auth) return c.notFound();
  const signedIn = await getOperatorSession(c.env, c.req.raw.headers, auth);
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  c.header("Referrer-Policy", "no-referrer");
  const body = jsx(
    "main",
    null,
    jsx("h1", null, "Meguri"),
    signedIn &&
      c.env.CREDENTIALS &&
      c.env.CREDENTIAL_ENCRYPTION_KEY &&
      jsx("p", null, jsx("a", { href: "/connect" }, "ChatGPT 接続")),
    c.req.query("error") && jsx("p", null, "ログインできませんでした。"),
    jsx(
      "form",
      { method: "post", action: signedIn ? "/logout" : loginPath },
      jsx(
        "button",
        { type: "submit" },
        signedIn ? "ログアウト" : "GitHub でログイン",
      ),
    ),
  );
  return c.html(
    "<!doctype html>" +
      jsx(
        "html",
        { lang: "ja" },
        jsx(
          "head",
          null,
          jsx("meta", { charset: "utf-8" }),
          jsx("title", null, "Meguri"),
        ),
        jsx("body", null, body),
      ).toString(),
  );
});

function redirectAfterAuth(response: Response, location: string) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Type");
  headers.set("Location", location);
  return new Response(null, { headers, status: 303 });
}

loginRoutes.post(loginPath, loginOrigin, async (c) => {
  const auth = createLoginAuth(c.env);
  if (!auth) return c.notFound();
  const response = await auth.api.signInSocial({
    body: { provider: providerId, callbackURL: loginPath },
    headers: c.req.raw.headers,
    asResponse: true,
  });
  const location = response.headers.get("Location");
  return response.ok && location
    ? redirectAfterAuth(response, location)
    : response;
});

loginRoutes.get(authPath + "/callback/github", loginOrigin, (c) => {
  const auth = createLoginAuth(c.env);
  return auth ? auth.handler(c.req.raw) : c.notFound();
});

loginRoutes.post("/logout", loginOrigin, async (c) => {
  const auth = createLoginAuth(c.env);
  if (!auth) return c.notFound();
  const response = await auth.api.signOut({
    headers: c.req.raw.headers,
    asResponse: true,
  });
  return response.ok ? redirectAfterAuth(response, loginPath) : response;
});

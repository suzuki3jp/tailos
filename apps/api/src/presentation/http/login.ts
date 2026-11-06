import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { jsx } from "hono/jsx";
import type { Bindings } from "../../bindings.ts";
import type { LoginAuth } from "../../application/auth/login.ts";

const providerId = "github";
const authPath = "/api/auth";
const loginPath = "/login";

export function createLoginRoutes(
  createLoginAuth: (env: Bindings) => LoginAuth | null,
  getOperatorSession: (
    env: Bindings,
    headers: Headers,
    auth: LoginAuth,
  ) => Promise<{ user: { id: string } } | null>,
) {
  const loginRoutes = new Hono<{ Bindings: Bindings }>();

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

  return loginRoutes;
}

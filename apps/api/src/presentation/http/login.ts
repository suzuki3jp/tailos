import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Bindings } from "../../bindings.ts";
import type { LoginAuth } from "../../application/auth/login.ts";

export function createLoginRoutes(
  createLoginAuth: (env: Bindings) => LoginAuth | null,
) {
  const loginOrigin = createMiddleware<{ Bindings: Bindings }>(
    async (c, next) => {
      const origin = c.env?.TAILOS_PUBLIC_ORIGIN;
      const webOrigin = c.env?.TAILOS_WEB_ORIGIN;
      if (!origin || !webOrigin || new URL(c.req.url).origin !== origin)
        return c.notFound();
      if (c.req.method === "POST" && c.req.header("Origin") !== webOrigin)
        return c.text("Forbidden", 403);
      await next();
      c.header("Cache-Control", "private, no-store");
    },
  );

  function redirectAfterAuth(response: Response, location: string) {
    const headers = new Headers(response.headers);
    headers.delete("Content-Type");
    headers.set("Location", location);
    return new Response(null, { headers, status: 303 });
  }

  return new Hono<{ Bindings: Bindings }>()
    .post("/login", loginOrigin, async (c) => {
      const auth = createLoginAuth(c.env);
      if (!auth) return c.notFound();
      const response = await auth.api.signInSocial({
        body: {
          provider: "github",
          callbackURL: new URL("/login", c.env.TAILOS_WEB_ORIGIN).href,
        },
        headers: c.req.raw.headers,
        asResponse: true,
      });
      const location = response.headers.get("Location");
      return response.ok && location
        ? redirectAfterAuth(response, location)
        : response;
    })
    .get("/callback/github", loginOrigin, (c) => {
      const auth = createLoginAuth(c.env);
      return auth ? auth.handler(c.req.raw) : c.notFound();
    })
    .post("/logout", loginOrigin, async (c) => {
      const auth = createLoginAuth(c.env);
      if (!auth) return c.notFound();
      const response = await auth.api.signOut({
        headers: c.req.raw.headers,
        asResponse: true,
      });
      return response.ok
        ? redirectAfterAuth(
            response,
            new URL("/login", c.env.TAILOS_WEB_ORIGIN).href,
          )
        : response;
    });
}

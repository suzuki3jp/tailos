import { createMiddleware } from "hono/factory";
import type { Bindings } from "../../../bindings.ts";

export const loginOrigin = createMiddleware<{ Bindings: Bindings }>(
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

import { basicAuth } from "hono/basic-auth";
import { createMiddleware } from "hono/factory";
import type { Bindings } from "../internal.ts";

export const operatorAuth = createMiddleware<{ Bindings: Bindings }>(
  async (c, next) => {
    const token = c.env?.MEGURI_OPERATOR_TOKEN;
    if (!token) return c.notFound();

    const url = new URL(c.req.url);
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (url.protocol !== "https:" && !local) return c.notFound();

    c.header("Cache-Control", "private, no-store");
    if (c.req.method === "POST" && c.req.header("Origin") !== url.origin)
      return c.text("Forbidden", 403);
    return basicAuth({ username: "meguri", password: token, realm: "Meguri" })(
      c,
      next,
    );
  },
);

import { createMiddleware } from "hono/factory";
import type { Bindings } from "../../../bindings.ts";

export type OperatorEnv = {
  Bindings: Bindings;
  Variables: { operatorUserId: string };
};

export function createOperatorAuth(
  getOperatorSession: (
    env: Bindings,
    headers: Headers,
  ) => Promise<{ user: { id: string } } | null>,
) {
  return createMiddleware<OperatorEnv>(async (c, next) => {
    const origin = c.env?.MEGURI_PUBLIC_ORIGIN;
    if (
      !origin ||
      !c.env.BETTER_AUTH_SECRET ||
      new URL(c.req.url).origin !== origin
    )
      return c.notFound();

    c.header("Cache-Control", "private, no-store");
    if (c.req.method === "POST" && c.req.header("Origin") !== origin)
      return c.text("Forbidden", 403);
    const session = await getOperatorSession(c.env, c.req.raw.headers);
    if (!session) {
      return c.req.method === "GET"
        ? c.redirect("/login", 303)
        : c.text("Unauthorized", 401);
    }
    c.set("operatorUserId", session.user.id);
    return next();
  });
}

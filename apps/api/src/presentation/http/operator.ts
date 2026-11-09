import { createMiddleware } from "hono/factory";
import type { Bindings } from "../../bindings.ts";

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
    const webOrigin = c.env?.MEGURI_WEB_ORIGIN;
    c.header("Cache-Control", "private, no-store");
    if (
      !origin ||
      !webOrigin ||
      !c.env.BETTER_AUTH_SECRET ||
      new URL(c.req.url).origin !== origin
    )
      return c.json({ error: "not_found" as const }, 404);

    if (c.req.method === "POST" && c.req.header("Origin") !== webOrigin)
      return c.json({ error: "forbidden" as const }, 403);
    const session = await getOperatorSession(c.env, c.req.raw.headers);
    if (!session) return c.json({ error: "unauthorized" as const }, 401);
    c.set("operatorUserId", session.user.id);
    return next();
  });
}

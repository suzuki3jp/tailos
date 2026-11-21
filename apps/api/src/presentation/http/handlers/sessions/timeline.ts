import { Hono } from "hono";
import { validator } from "hono/validator";
import type { TimelineReader } from "@/application/sessions/timeline.ts";
import type { Bindings } from "@/bindings.ts";
import type {
  createOperatorAuth,
  OperatorEnv,
} from "@/presentation/http/middlewares/operator.ts";

function position(url: string, key: string) {
  const values = new URL(url).searchParams.getAll(key);
  if (!values.length) return undefined;
  if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0])) return null;
  const value = Number(values[0]);
  return Number.isSafeInteger(value) ? value : null;
}

export function createTimelineRoutes(
  reader: (env: Bindings) => TimelineReader,
  operatorAuth: ReturnType<typeof createOperatorAuth>,
) {
  return new Hono<OperatorEnv>()
    .use("*", operatorAuth, async (c, next) => {
      const id = c.req.param("id");
      const projectId = c.req.param("projectId");
      if (
        !id ||
        !(await reader(c.env).owned(id, c.var.operatorUserId, projectId))
      )
        return c.json({ error: "not_found" as const }, 404);
      return next();
    })
    .get(
      "/timeline",
      validator("query", (query: { before?: string }) => query),
      async (c) => {
        const before = position(c.req.url, "before");
        if (before === null || before === 0)
          return c.json({ error: "invalid_cursor" as const }, 400);
        return c.json(await reader(c.env).snapshot(c.req.param("id")!, before));
      },
    )
    .get(
      "/events",
      validator("query", (query: { after?: string }) => query),
      async (c) => {
        const after = position(c.req.url, "after");
        if (after == null)
          return c.json({ error: "invalid_cursor" as const }, 400);
        const changes = await reader(c.env).changes(c.req.param("id")!, after);
        return changes
          ? c.json(changes)
          : c.json({ error: "reset_required" as const }, 409);
      },
    )
    .get("/items/:itemId/output", async (c) => {
      try {
        const output = await reader(c.env).output(
          c.req.param("id")!,
          c.req.param("itemId"),
        );
        if (!output) return c.json({ error: "not_found" as const }, 404);
        return output.expired
          ? c.json({ error: "expired" as const }, 410)
          : c.json(output);
      } catch {
        return c.json({ error: "output_unavailable" as const }, 503);
      }
    })
    .get("/stream", async (c) => {
      // Browser WebSocket upgrades use GET; POST-only CSRF checks are insufficient.
      if (c.req.header("Origin") !== c.env.TAILOS_WEB_ORIGIN)
        return c.json({ error: "forbidden" as const }, 403);
      if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
        return c.body(null, 426);
      const loginId = c.var.operatorSessionId;
      if (!c.env.SESSION_STREAM || !loginId)
        return c.json({ error: "stream_unavailable" as const }, 503);
      const id = c.req.param("id")!;
      const headers = new Headers({
        Upgrade: "websocket",
        "X-Tailos-Session": id,
        "X-Tailos-Owner": c.var.operatorUserId,
        "X-Tailos-Login": loginId,
      });
      const projectId = c.req.param("projectId");
      if (projectId) headers.set("X-Tailos-Project", projectId);
      return c.env.SESSION_STREAM.getByName(id).fetch(
        "https://session.internal/stream",
        { headers: Object.fromEntries(headers) },
      );
    });
}

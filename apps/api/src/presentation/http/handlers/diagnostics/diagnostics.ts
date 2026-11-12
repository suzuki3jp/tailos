import { Hono } from "hono";
import { validator } from "hono/validator";
import type { DiagnosticReader } from "@/application/diagnostics/store.ts";
import type { Bindings } from "@/bindings.ts";
import type {
  createOperatorAuth,
  OperatorEnv,
} from "@/presentation/http/middlewares/operator.ts";

const integer = (value: string | undefined) =>
  value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
const traceCursor = (value: string | undefined) => {
  const match = value && /^(\d{1,15}):([a-zA-Z0-9_./:-]{1,200})$/.exec(value);
  return match ? { at: Number(match[1]), id: match[2]! } : undefined;
};

export function createDiagnosticRoutes(
  reader: (env: Bindings) => DiagnosticReader,
  auth: ReturnType<typeof createOperatorAuth>,
) {
  const cursorQuery = validator("query", (value, c) => {
    const after = value.after;
    if (
      after !== undefined &&
      (typeof after !== "string" || integer(after) === undefined)
    )
      return c.json({ error: "invalid_cursor" as const }, 400);
    return { after };
  });
  const traceQuery = validator("query", (value, c) => {
    const { runId, source, deliveryId, before } = value;
    if (
      [runId, source, deliveryId].some(
        (item) =>
          item !== undefined && (typeof item !== "string" || item.length > 200),
      ) ||
      (before !== undefined &&
        (typeof before !== "string" || traceCursor(before) === undefined))
    )
      return c.json({ error: "invalid_query" as const }, 400);
    return {
      runId: typeof runId === "string" ? runId : undefined,
      source: typeof source === "string" ? source : undefined,
      deliveryId: typeof deliveryId === "string" ? deliveryId : undefined,
      before: typeof before === "string" ? before : undefined,
    };
  });
  return new Hono<OperatorEnv>()
    .use("*", auth)
    .get("/traces", traceQuery, async (c) => {
      const { runId, source, deliveryId, before } = c.req.valid("query");
      return c.json(
        await reader(c.env).traces(c.var.operatorUserId, {
          runId,
          source,
          deliveryId,
          before: traceCursor(before),
        }),
      );
    })
    .get("/traces/:id/events", cursorQuery, async (c) => {
      const { after } = c.req.valid("query");
      const result = await reader(c.env).events(
        c.var.operatorUserId,
        c.req.param("id"),
        integer(after) ?? 0,
      );
      return result === null
        ? c.json({ error: "not_found" }, 404)
        : c.json(result);
    })
    .get("/traces/:id/artifacts", cursorQuery, async (c) => {
      const { after } = c.req.valid("query");
      const result = await reader(c.env).artifacts(
        c.var.operatorUserId,
        c.req.param("id"),
        integer(after) ?? 0,
      );
      return result === null
        ? c.json({ error: "not_found" }, 404)
        : c.json(result);
    })
    .get("/artifacts/:id", async (c) => {
      try {
        return (
          (await reader(c.env).body(c.var.operatorUserId, c.req.param("id"))) ??
          c.json({ error: "not_found" }, 404)
        );
      } catch {
        return c.json({ error: "artifact_unreadable" }, 502);
      }
    });
}

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { issueMcpKey, type McpKeyStore } from "@/application/auth/mcp-key.ts";
import type { Bindings } from "@/bindings.ts";
import type {
  createOperatorAuth,
  OperatorEnv,
} from "@/presentation/http/middlewares/operator.ts";

const inputSchema = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  lifetimeDays: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(90)),
    30,
  ),
});

export function createMcpKeyRoutes(
  store: (env: Bindings) => McpKeyStore,
  auth: ReturnType<typeof createOperatorAuth>,
) {
  return new Hono<OperatorEnv>()
    .use("*", auth)
    .get("/", async (c) =>
      c.json({
        keys: await store(c.env).list(c.var.operatorUserId),
        endpoint: new URL("/mcp", c.env.TAILOS_PUBLIC_ORIGIN).href,
      }),
    )
    .post("/", bodyLimit({ maxSize: 4096 }), async (c) => {
      const parsed = v.safeParse(
        inputSchema,
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        return c.json({ error: "invalid_input" as const }, 400);
      const issued = await issueMcpKey(
        store(c.env),
        c.var.operatorUserId,
        parsed.output.name,
        parsed.output.lifetimeDays,
      );
      return issued
        ? c.json(issued, 201)
        : c.json({ error: "key_limit" as const }, 409);
    })
    .post("/:id/revoke", async (c) => {
      const id = v.safeParse(v.pipe(v.string(), v.uuid()), c.req.param("id"));
      if (
        !id.success ||
        !(await store(c.env).revoke(
          c.var.operatorUserId,
          id.output,
          Date.now(),
        ))
      )
        return c.json({ error: "not_found" as const }, 404);
      return c.json({ revoked: true as const });
    });
}

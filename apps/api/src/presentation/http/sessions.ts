import {
  createSession,
  type SessionStore,
} from "../../application/sessions/create-session.ts";
import type { createOperatorAuth, OperatorEnv } from "./operator.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";

import { smokeAuth, smokeOwnerId } from "./smoke-auth.ts";
import { type Bindings } from "../../bindings.ts";

const sessionInput = v.strictObject({
  messages: v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000))),
    v.minLength(1),
    v.maxLength(20),
  ),
});

export function createSessionRoutes<Detail>(
  store: (env: Bindings) => SessionStore<Detail>,
  operatorAuth: ReturnType<typeof createOperatorAuth>,
) {
  const sessionRoutes = new Hono<{ Bindings: Bindings }>();

  sessionRoutes.use("*", smokeAuth);

  sessionRoutes.post("/", bodyLimit({ maxSize: 128 * 1024 }), async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = v.safeParse(sessionInput, body);
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const id = await createSession(
      store(c.env),
      smokeOwnerId,
      parsed.output.messages,
    );
    return c.json({ id }, 201);
  });

  sessionRoutes.get("/:id", async (c) => {
    const detail = await store(c.env).read(c.req.param("id"), smokeOwnerId);
    return detail ? c.json(detail) : c.notFound();
  });

  const userSessionRoutes = new Hono<OperatorEnv>();
  userSessionRoutes.use("*", operatorAuth);
  userSessionRoutes.get("/:id", async (c) => {
    const detail = await store(c.env).read(
      c.req.param("id"),
      c.var.operatorUserId,
    );
    return detail ? c.json(detail) : c.notFound();
  });

  return { sessionRoutes, userSessionRoutes };
}

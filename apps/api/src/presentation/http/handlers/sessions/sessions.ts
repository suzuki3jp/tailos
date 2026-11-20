import { maxPromptLength } from "@tailos/core/runner";
import {
  createSession,
  type SessionStore,
} from "@/application/sessions/create-session.ts";
import type {
  createOperatorAuth,
  OperatorEnv,
} from "@/presentation/http/middlewares/operator.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import * as v from "valibot";
import {
  listSessions,
  sessionListInput,
  type SessionListStore,
} from "@/application/sessions/list-sessions.ts";

import {
  smokeAuth,
  smokeOwnerId,
} from "@/presentation/http/middlewares/smoke-auth.ts";
import { type Bindings } from "@/bindings.ts";

const sessionInput = v.strictObject({
  messages: v.pipe(
    v.array(
      v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(maxPromptLength),
      ),
    ),
    v.minLength(1),
    v.maxLength(20),
  ),
});

export function createSessionRoutes<Detail>(
  store: (env: Bindings) => SessionStore<Detail> &
    SessionListStore & {
      projectName(id: string, ownerId: string): Promise<string | null>;
    },
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

  const userSessionRoutes = new Hono<OperatorEnv>()
    .use("*", operatorAuth)
    .get("/", async (c) => {
      const input = sessionListInput(new URL(c.req.url).searchParams);
      if (!input) return c.json({ error: "invalid_input" as const }, 400);
      return c.json(
        await listSessions(store(c.env), c.var.operatorUserId, input),
      );
    })
    .get("/:id", async (c) => {
      const detail = await store(c.env).read(
        c.req.param("id"),
        c.var.operatorUserId,
      );
      return detail
        ? c.json(detail)
        : c.json({ error: "not_found" as const }, 404);
    });

  const projectSessionRoutes = new Hono<OperatorEnv>()
    .get(
      "/",
      operatorAuth,
      validator("query", (query: { limit?: string; cursor?: string }) => query),
      async (c) => {
        // Preserve repeated keys so the shared parser can reject them.
        const input = sessionListInput(new URL(c.req.url).searchParams);
        const projectId = c.req.param("projectId");
        if (!input || !projectId)
          return c.json({ error: "invalid_input" as const }, 400);
        return c.json(
          await listSessions(
            store(c.env),
            c.var.operatorUserId,
            input,
            projectId,
          ),
        );
      },
    )
    .get("/:id", operatorAuth, async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) return c.json({ error: "not_found" as const }, 404);
      const owner = c.var.operatorUserId;
      const sessions = store(c.env);
      const [detail, projectName] = await Promise.all([
        sessions.read(c.req.param("id"), owner, projectId),
        sessions.projectName(projectId, owner),
      ]);
      return detail
        ? c.json({ detail, projectName })
        : c.json({ error: "not_found" as const }, 404);
    });

  return { sessionRoutes, userSessionRoutes, projectSessionRoutes };
}

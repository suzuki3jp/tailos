import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { runs, sessionMessages, sessions } from "./db/schema.ts";

import { smokeAuth, smokeOwnerId, type Bindings } from "./internal.ts";

const sessionInput = v.strictObject({
  messages: v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000))),
    v.minLength(1),
    v.maxLength(20),
  ),
});

export const sessionRoutes = new Hono<{ Bindings: Bindings }>();

sessionRoutes.use("*", smokeAuth);

sessionRoutes.post("/", bodyLimit({ maxSize: 128 * 1024 }), async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = v.safeParse(sessionInput, body);
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

  const db = drizzle(c.env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  const messages = parsed.output.messages.map((body, index) => ({
    id: crypto.randomUUID(),
    sessionId: id,
    authorKind: "user" as const,
    body,
    seq: index + 1,
    createdAt: now,
  }));
  await db.batch([
    db.insert(sessions).values({ id, ownerId: smokeOwnerId, createdAt: now }),
    ...messages.map((message) => db.insert(sessionMessages).values(message)),
  ]);
  return c.json({ id }, 201);
});

sessionRoutes.get("/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.ownerId, smokeOwnerId)));
  if (!session) return c.notFound();

  const messages = await db
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, id))
    .orderBy(asc(sessionMessages.seq));
  const executions = await db
    .select({
      id: runs.id,
      status: runs.status,
      result: runs.result,
      errorCode: runs.errorCode,
    })
    .from(runs)
    .where(eq(runs.sessionId, id))
    .orderBy(asc(runs.createdAt), asc(runs.id));
  return c.json({ session, messages, runs: executions });
});

import { Hono } from "hono";
import * as v from "valibot";
import { smokeAuth, smokeOwnerId, type Bindings } from "./internal.ts";

const runIdSchema = v.pipe(v.string(), v.uuid());
export const runRoutes = new Hono<{ Bindings: Bindings }>();

runRoutes.use("*", smokeAuth);
runRoutes.post("/:id/start", async (c) => {
  const id = v.safeParse(runIdSchema, c.req.param("id"));
  if (!id.success) return c.notFound();
  const run = await c.env.DB.prepare(
    `SELECT runs.id FROM runs JOIN sessions ON sessions.id = runs.session_id
     WHERE runs.id = ? AND sessions.owner_id = ?`,
  )
    .bind(id.output, smokeOwnerId)
    .first();
  if (!run) return c.notFound();

  const runner = c.env.RUNNER;
  if (!runner) return c.json({ error: "runner_unavailable" }, 503);
  const status = await runner.getByName(id.output).execute(id.output);
  return c.json({ runId: id.output, status });
});

import { Hono } from "hono";
import * as v from "valibot";
import { smokeAuth, smokeOwnerId } from "./smoke-auth.ts";
import { type Bindings } from "../../bindings.ts";

const runIdSchema = v.pipe(v.string(), v.uuid());
export function createRunRoutes(
  findOwnedRun: (
    env: Bindings,
    id: string,
    ownerId: string,
  ) => Promise<unknown | null>,
) {
  const runRoutes = new Hono<{ Bindings: Bindings }>();

  runRoutes.use("*", smokeAuth);
  runRoutes.post("/:id/start", async (c) => {
    const id = v.safeParse(runIdSchema, c.req.param("id"));
    if (!id.success) return c.notFound();
    const run = await findOwnedRun(c.env, id.output, smokeOwnerId);
    if (!run) return c.notFound();

    const runner = c.env.RUNNER;
    if (!runner) return c.json({ error: "runner_unavailable" }, 503);
    const status = await runner.getByName(id.output).execute(id.output);
    return c.json({ runId: id.output, status });
  });

  return runRoutes;
}

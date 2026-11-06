import { Hono } from "hono";
import * as v from "valibot";
import type { Bindings } from "../../bindings.ts";

const uuid = v.pipe(v.string(), v.uuid());

export function createRefreshRoutes(
  findActiveRun: (
    env: Bindings,
    runId: string,
    now: number,
  ) => Promise<unknown>,
) {
  const refreshRoutes = new Hono<{ Bindings: Bindings }>();
  refreshRoutes.post("/:runId/credentials", async (c) => {
    c.header("Cache-Control", "no-store");
    const runId = v.safeParse(uuid, c.req.param("runId"));
    const authorization = c.req.header("Authorization") ?? "";
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1];
    const rejected = v.safeParse(uuid, c.req.header("X-Meguri-Access-Version"));
    if (!runId.success || !bearer || !rejected.success || !c.env.RUNNER)
      return c.json({ error: "invalid_lease" }, 401);

    try {
      const run = await findActiveRun(c.env, runId.output, Date.now());
      if (!run) return c.json({ error: "invalid_lease" }, 401);
      const result = await c.env.RUNNER.getByName(runId.output).refreshAccess(
        runId.output,
        bearer,
        rejected.output,
      );
      return result ? c.json(result) : c.json({ error: "invalid_lease" }, 401);
    } catch {
      return c.json({ error: "credentials_unavailable" }, 503);
    }
  });

  return refreshRoutes;
}

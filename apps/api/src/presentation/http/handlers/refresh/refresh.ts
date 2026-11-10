import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { legacyPublicationSchema } from "../../../../application/runs/publication.ts";
import {
  checkedPublicationSchema,
  maxPublicationBytes,
} from "@tailos/core/runner";
import * as v from "valibot";
import type { Bindings } from "../../../../bindings.ts";

const runnerBearer = /^Bearer ([a-f0-9]{64})$/;
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
    const bearer = runnerBearer.exec(authorization)?.[1];
    const rejected = v.safeParse(uuid, c.req.header("X-Tailos-Access-Version"));
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

  refreshRoutes.post(
    "/:runId/publication",
    bodyLimit({ maxSize: maxPublicationBytes }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const runId = v.safeParse(uuid, c.req.param("runId"));
      const bearer = runnerBearer.exec(
        c.req.header("Authorization") ?? "",
      )?.[1];
      if (!runId.success || !bearer || !c.env.RUNNER)
        return c.json({ error: "invalid_lease" }, 401);

      const work = v.safeParse(
        v.union([checkedPublicationSchema, legacyPublicationSchema]),
        await c.req.json().catch(() => null),
      );
      if (!work.success || work.output.kind === "pushed")
        return c.json({ error: "invalid_publication" }, 400);
      try {
        const run = await findActiveRun(c.env, runId.output, Date.now());
        if (!run) return c.json({ error: "invalid_lease" }, 401);
        const staged = await c.env.RUNNER.getByName(
          runId.output,
        ).stagePublication(runId.output, bearer, work.output);
        return staged
          ? c.body(null, 204)
          : c.json({ error: "invalid_lease" }, 401);
      } catch {
        return c.json({ error: "publication_unavailable" }, 503);
      }
    },
  );

  return refreshRoutes;
}

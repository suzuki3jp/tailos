import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import * as v from "valibot";
import { smokeAuth, smokeOwnerId, type Bindings } from "./internal.ts";
import { readRunArtifact } from "./run-artifacts.ts";

const runIdSchema = v.pipe(v.string(), v.uuid());
const artifactSchema = v.picklist(["events.ndjson", "result.json"]);
export const runRoutes = new Hono<{ Bindings: Bindings }>();

async function findOwnedRun(db: D1Database, id: string) {
  const runId = v.safeParse(runIdSchema, id);
  if (!runId.success) return null;
  return db
    .prepare(
      `SELECT runs.id, runs.status, runs.error_code AS errorCode FROM runs JOIN sessions ON sessions.id = runs.session_id
     WHERE runs.id = ? AND sessions.owner_id = ?`,
    )
    .bind(runId.output, smokeOwnerId)
    .first<{ id: string; status: string; errorCode: string | null }>();
}

runRoutes.use("*", smokeAuth);
runRoutes.post("/:id/start", async (c) => {
  const run = await findOwnedRun(c.env.DB, c.req.param("id"));
  if (!run) return c.notFound();

  const runner = c.env.RUNNER;
  if (!runner) return c.json({ error: "runner_unavailable" }, 503);
  if (run.status === "queued" || run.status === "running") {
    await runner.getByName(run.id).schedule(run.id);
    return c.json({ runId: run.id, status: run.status }, 202);
  }
  return c.json({ runId: run.id, status: run.status });
});

runRoutes.get("/:id/artifacts/:file", async (c) => {
  const file = v.safeParse(artifactSchema, c.req.param("file"));
  if (!file.success) return c.notFound();
  const run = await findOwnedRun(c.env.DB, c.req.param("id"));
  const artifacts = c.env.RUN_ARTIFACTS;
  if (!artifacts || (run?.status !== "succeeded" && run?.status !== "failed"))
    return c.notFound();
  const terminal =
    run.status === "succeeded"
      ? ({ status: run.status } as const)
      : ({
          status: run.status,
          errorCode: run.errorCode ?? "unknown",
        } as const);
  try {
    return (
      (await readRunArtifact(artifacts, run.id, file.output, terminal)) ??
      c.notFound()
    );
  } catch {
    return c.json({ error: "artifact_unreadable" }, 502);
  }
});

import type { TerminalResult } from "../../application/runs/artifacts.ts";
import { Hono } from "hono";
import * as v from "valibot";
import { smokeAuth, smokeOwnerId } from "./smoke-auth.ts";
import { type Bindings } from "../../bindings.ts";

const runIdSchema = v.pipe(v.string(), v.uuid());
const artifactSchema = v.picklist(["events.ndjson", "result.json"]);
export function createRunRoutes(
  startRun: (env: Bindings) => ((id: string) => Promise<void>) | undefined,
  findOwnedRun: (
    env: Bindings,
    id: string,
    ownerId: string,
  ) => Promise<{ id: string; status: string; errorCode: string | null } | null>,
  readRunArtifact: (
    env: Bindings,
    id: string,
    file: "events.ndjson" | "result.json",
    result: TerminalResult,
  ) => Promise<Response | null>,
) {
  const runRoutes = new Hono<{ Bindings: Bindings }>();

  async function ownedRun(env: Bindings, id: string) {
    const runId = v.safeParse(runIdSchema, id);
    return runId.success ? findOwnedRun(env, runId.output, smokeOwnerId) : null;
  }

  runRoutes.use("*", smokeAuth);
  runRoutes.post("/:id/start", async (c) => {
    const run = await ownedRun(c.env, c.req.param("id"));
    if (!run) return c.notFound();

    if (run.status === "queued" || run.status === "running") {
      const start = startRun(c.env);
      if (!start) return c.json({ error: "runner_unavailable" }, 503);
      await start(run.id);
      return c.json({ runId: run.id, status: run.status }, 202);
    }
    return c.json({ runId: run.id, status: run.status });
  });

  runRoutes.get("/:id/artifacts/:file", async (c) => {
    const file = v.safeParse(artifactSchema, c.req.param("file"));
    if (!file.success) return c.notFound();
    const run = await ownedRun(c.env, c.req.param("id"));
    if (run?.status !== "succeeded" && run?.status !== "failed")
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
        (await readRunArtifact(c.env, run.id, file.output, terminal)) ??
        c.notFound()
      );
    } catch {
      return c.json({ error: "artifact_unreadable" }, 502);
    }
  });

  return runRoutes;
}

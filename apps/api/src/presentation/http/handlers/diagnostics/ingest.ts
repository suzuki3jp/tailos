import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  diagnosticBatchSchema,
  maxDiagnosticBatch,
} from "@tailos/core/diagnostics";
import * as v from "valibot";
import type { Bindings } from "@/bindings.ts";

export function createDiagnosticIngestRoutes(
  canIngest: (env: Bindings, runId: string, now: number) => Promise<boolean>,
) {
  const diagnosticIngestRoutes = new Hono<{ Bindings: Bindings }>();
  diagnosticIngestRoutes.post(
    "/:runId/diagnostics",
    bodyLimit({ maxSize: maxDiagnosticBatch }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const runId = v.safeParse(
        v.pipe(v.string(), v.uuid()),
        c.req.param("runId"),
      );
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(
        c.req.header("Authorization") ?? "",
      )?.[1];
      if (!runId.success || !bearer || !c.env.RUNNER)
        return c.json({ error: "invalid_lease" }, 401);
      const batch = v.safeParse(
        diagnosticBatchSchema,
        await c.req.json().catch(() => null),
      );
      if (!batch.success) return c.json({ error: "invalid_diagnostics" }, 400);
      try {
        if (!(await canIngest(c.env, runId.output, Date.now())))
          return c.json({ error: "invalid_lease" }, 401);
        const accepted = await c.env.RUNNER.getByName(
          runId.output,
        ).ingestDiagnostics(runId.output, bearer, batch.output);
        return accepted
          ? c.body(null, 204)
          : c.json({ error: "invalid_lease" }, 401);
      } catch {
        return c.json({ error: "diagnostics_unavailable" }, 503);
      }
    },
  );
  return diagnosticIngestRoutes;
}

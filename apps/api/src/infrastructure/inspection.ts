import type { InspectionStore } from "@/application/inspection/inspection.ts";
import type { Bindings } from "@/bindings.ts";
import { d1Inspection } from "@/infrastructure/d1/inspection.ts";
import { readRunArtifact } from "@/infrastructure/r2/run-artifacts.ts";
import { diagnosticReader } from "@/infrastructure/diagnostics/store.ts";

export function inspectionStore(env: Bindings): InspectionStore {
  const reads = d1Inspection(env.DB);
  const diagnostics = diagnosticReader(env.DB, env.RUN_ARTIFACTS);
  return {
    ...reads,
    diagnostics,
    async readDiagnosticArtifact(ownerId, artifactId, offset, limit) {
      try {
        const response = await diagnostics.body(ownerId, artifactId);
        if (!response) return { state: "not_found" };
        if (response.status === 410) return { state: "expired" };
        if (!response.ok) return { state: "unreadable" };
        // The diagnostics store bounds a saved batch and verifies its digest.
        // Slice by code points, as with message chunks, to preserve Unicode.
        const points = Array.from(await response.text());
        return {
          state: "available",
          text: points.slice(offset, offset + limit).join(""),
          totalLength: points.length,
          nextOffset: offset + limit < points.length ? offset + limit : null,
        };
      } catch {
        return { state: "unreadable" };
      }
    },
    async readRunArtifact(ownerId, runId, file) {
      const run = await reads.getRun(ownerId, runId);
      if (!run) return { state: "not_found" };
      if (run.status !== "succeeded" && run.status !== "failed")
        return { state: "not_ready" };
      if (!env.RUN_ARTIFACTS) return { state: "unavailable" };
      const terminal =
        run.status === "succeeded"
          ? { status: run.status }
          : { status: run.status, errorCode: run.errorCode ?? "unknown" };
      try {
        const response = await readRunArtifact(
          env.RUN_ARTIFACTS,
          runId,
          file,
          terminal,
        );
        return response
          ? { state: "available", text: await response.text() }
          : { state: "unavailable" };
      } catch {
        return { state: "unreadable" };
      }
    },
  };
}

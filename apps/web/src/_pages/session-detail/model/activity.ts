import type { SessionRun } from "../api/queries";

export function runActivityLabel(run: SessionRun) {
  if (run.status === "queued") return "Queued";
  if (run.status === "running") return "Working…";
  if (run.status === "failed") return "Run failed";
  if (run.agentDurationMs === null) return "Completed";
  const seconds = Math.floor(run.agentDurationMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `Worked for ${minutes ? `${minutes}m ` : ""}${seconds % 60}s`;
}

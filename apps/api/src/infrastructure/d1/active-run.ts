import type { D1Database } from "@cloudflare/workers-types";

export function findActiveRun(db: D1Database, runId: string, now: number) {
  return db
    .prepare(
      "SELECT id FROM runs WHERE id = ? AND status = 'running' AND deadline_at > ?",
    )
    .bind(runId, now)
    .first();
}

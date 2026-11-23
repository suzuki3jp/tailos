import type { D1Database } from "@cloudflare/workers-types";

/** The Session of a Run that is still running, which names its Runner. */
export function findActiveRun(db: D1Database, runId: string, now: number) {
  return db
    .prepare(
      "SELECT session_id AS sessionId FROM runs WHERE id = ? AND status = 'running' AND deadline_at > ?",
    )
    .bind(runId, now)
    .first<{ sessionId: string }>();
}

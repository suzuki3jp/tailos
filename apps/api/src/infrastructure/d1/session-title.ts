import type { D1Database } from "@cloudflare/workers-types";
import { normalizeSessionTitle } from "@tailos/core/runner";

// Execute in the same batch that accepts the response/checkpoint. The session's
// confirmation flag arbitrates concurrent responses and idempotent replays.
export function sessionTitleStatement(
  db: D1Database,
  runId: string,
  title: unknown,
  checkpoint: string | null = null,
) {
  const normalized = normalizeSessionTitle(title) ?? null;
  return db
    .prepare(`UPDATE sessions SET title = ?, title_generated = 1
    WHERE title_generated = 0 AND ? IS NOT NULL AND id = (
      SELECT session_id FROM runs WHERE id = ? AND status = 'running'
      AND (? IS NULL OR json_extract(step_state, '$.pendingPublication') = json(?)))`)
    .bind(normalized, normalized, runId, checkpoint, checkpoint);
}

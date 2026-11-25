import type { D1Database } from "@cloudflare/workers-types";
import { normalizeSessionTitle } from "@tailos/core/runner";

// Execute in the same batch that accepts the response. The session's
// confirmation flag arbitrates concurrent responses and idempotent replays.
export function sessionTitleStatement(
  db: D1Database,
  runId: string,
  title: unknown,
) {
  const normalized = normalizeSessionTitle(title) ?? null;
  return db
    .prepare(`UPDATE sessions SET title = ?, title_generated = 1
    WHERE title_generated = 0 AND ? IS NOT NULL AND id = (
      SELECT session_id FROM runs WHERE id = ? AND status = 'running')`)
    .bind(normalized, normalized, runId);
}

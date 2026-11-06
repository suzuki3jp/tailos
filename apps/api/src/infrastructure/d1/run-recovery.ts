import type { D1Database } from "@cloudflare/workers-types";

export async function listDueRunIds(db: D1Database, now: number) {
  const due = await db
    .prepare(
      `SELECT id FROM runs WHERE status IN ('queued', 'running')
     AND (next_action_at <= ? OR (next_action_at IS NULL AND deadline_at <= ?))
     ORDER BY coalesce(next_action_at, deadline_at), id LIMIT 25`,
    )
    .bind(now, now)
    .all<{ id: string }>();
  return due.results.map(({ id }) => id);
}

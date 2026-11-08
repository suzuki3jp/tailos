import type { D1Database } from "@cloudflare/workers-types";

export async function listDueRunIds(db: D1Database, now: number) {
  const due = await db
    .prepare(
      `SELECT id FROM runs WHERE status IN ('queued', 'running')
     AND (next_action_at IS NULL OR next_action_at <= ?)
     ORDER BY next_action_at, id LIMIT 25`,
    )
    .bind(now)
    .all<{ id: string }>();
  return due.results.map(({ id }) => id);
}

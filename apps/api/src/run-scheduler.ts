import type { D1Database } from "@cloudflare/workers-types";

export async function rescheduleDueRuns(
  db: D1Database,
  schedule: (runId: string) => Promise<void>,
) {
  const now = Date.now();
  const due = await db
    .prepare(
      `SELECT id FROM runs WHERE status IN ('queued', 'running')
     AND (next_action_at <= ? OR (next_action_at IS NULL AND deadline_at <= ?))
     ORDER BY coalesce(next_action_at, deadline_at), id LIMIT 25`,
    )
    .bind(now, now)
    .all<{ id: string }>();

  const results = await Promise.allSettled(
    due.results.map(({ id }) => schedule(id)),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Some due runs could not be scheduled");
  }
}

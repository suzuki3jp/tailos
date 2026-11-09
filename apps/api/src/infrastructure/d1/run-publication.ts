import type { D1Database } from "@cloudflare/workers-types";
import type { PendingPublication } from "../../application/runs/publication.ts";

export async function stageRunPublication(
  db: D1Database,
  runId: string,
  work: PendingPublication,
) {
  const payload = JSON.stringify(work);
  const updated = await db
    .prepare(
      `UPDATE runs
     SET step_state = json_set(step_state, '$.pendingPublication', json(?))
     WHERE id = ? AND status = 'running'
       AND json_extract(step_state, '$.branch') = ?
       AND (json_extract(step_state, '$.pendingPublication') IS NULL
         OR json_extract(step_state, '$.pendingPublication') = json(?))`,
    )
    .bind(payload, runId, work.branch, payload)
    .run();
  return updated.meta.changes === 1;
}

export async function beginPublicationReconciliation(
  db: D1Database,
  runId: string,
  work: PendingPublication,
  pushed: boolean,
) {
  const updated = await db
    .prepare(
      `UPDATE runs SET step_state = json_set(
       step_state,
       '$.publicationStartedAt', coalesce(json_extract(step_state, '$.publicationStartedAt'), ?),
       '$.pendingPublication.kind', CASE WHEN ? THEN 'pushed' ELSE json_extract(step_state, '$.pendingPublication.kind') END)
     WHERE id = ? AND status = 'running'
       AND json_extract(step_state, '$.pendingPublication.branch') = ?
       AND json_extract(step_state, '$.pendingPublication.sha') = ?`,
    )
    .bind(Date.now(), Number(pushed), runId, work.branch, work.sha)
    .run();
  return updated.meta.changes === 1;
}

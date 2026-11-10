import type { D1Database } from "@cloudflare/workers-types";
import type {
  LegacyPublication,
  PendingPublication,
} from "#api/application/runs/publication.ts";

export async function stageRunPublication(
  db: D1Database,
  runId: string,
  work: PendingPublication,
) {
  const payload = JSON.stringify(work);
  const baseSha = work.kind === "checked" ? work.baseSha : null;
  const now = Date.now();
  const updated = await db
    .prepare(
      `UPDATE runs
     SET step_state = CASE WHEN ? IS NULL
       THEN json_set(step_state, '$.pendingPublication', json(?))
       ELSE json_set(step_state, '$.pendingPublication', json(?),
         '$.publicationStartedAt', coalesce(json_extract(step_state, '$.publicationStartedAt'), ?))
       END
     WHERE id = ? AND status = 'running'
       AND json_extract(step_state, '$.branch') = ?
       AND (CASE WHEN ? IS NULL
         THEN coalesce(json_extract(step_state, '$.version'), 1) = 1
         ELSE json_extract(step_state, '$.baseSha') = ? AND deadline_at > ?
       END)
       AND (json_extract(step_state, '$.pendingPublication') IS NULL
         OR json_extract(step_state, '$.pendingPublication') = json(?))`,
    )
    .bind(
      baseSha,
      payload,
      payload,
      now,
      runId,
      work.branch,
      baseSha,
      baseSha,
      now,
      payload,
    )
    .run();
  return updated.meta.changes === 1;
}

export async function beginPublicationReconciliation(
  db: D1Database,
  runId: string,
  work: LegacyPublication,
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

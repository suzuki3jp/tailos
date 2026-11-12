import type { D1Database } from "@cloudflare/workers-types";
import type {
  LegacyPublication,
  PendingPublication,
} from "@/application/runs/publication.ts";
import {
  ensureRunTrace,
  publicationEvent,
} from "@/infrastructure/diagnostics/journal.ts";

export async function stageRunPublication(
  db: D1Database,
  runId: string,
  work: PendingPublication,
) {
  const payload = JSON.stringify(work);
  const baseSha = work.kind === "checked" ? work.baseSha : null;
  const now = Date.now();
  const update = db
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
         OR json_extract(step_state, '$.pendingPublication') = json(?)) RETURNING id`,
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
    );
  const results = await db.batch([
    ...ensureRunTrace(db, runId, now),
    update,
    publicationEvent(
      db,
      runId,
      `publication/${runId}/${work.kind}/${work.kind === "checked" ? work.digest : work.sha}`,
      "publication.staged",
      now,
      work.kind === "checked"
        ? {
            kind: work.kind,
            branch: work.branch,
            baseSha: work.baseSha,
            digest: work.digest,
          }
        : { kind: work.kind, branch: work.branch, sha: work.sha },
      "changes() = 1 AND json_extract(step_state, '$.pendingPublication') = json(?)",
      [payload],
    ),
  ]);
  return results.at(-2)?.results.length === 1;
}

export async function beginPublicationReconciliation(
  db: D1Database,
  runId: string,
  work: LegacyPublication,
  pushed: boolean,
) {
  const now = Date.now();
  const update = db
    .prepare(
      `UPDATE runs SET step_state = json_set(
       step_state,
       '$.publicationStartedAt', coalesce(json_extract(step_state, '$.publicationStartedAt'), ?),
       '$.pendingPublication.kind', CASE WHEN ? THEN 'pushed' ELSE json_extract(step_state, '$.pendingPublication.kind') END)
     WHERE id = ? AND status = 'running'
       AND json_extract(step_state, '$.pendingPublication.branch') = ?
       AND json_extract(step_state, '$.pendingPublication.sha') = ? RETURNING id`,
    )
    .bind(now, Number(pushed), runId, work.branch, work.sha);
  const results = await db.batch([
    ...ensureRunTrace(db, runId, now),
    update,
    publicationEvent(
      db,
      runId,
      `reconciliation/${runId}/${work.sha}/${pushed ? "confirmed" : "started"}`,
      "publication.reconciled",
      now,
      { branch: work.branch, sha: work.sha, confirmed: pushed },
      "changes() = 1 AND json_extract(step_state, '$.pendingPublication.branch') = ? AND json_extract(step_state, '$.pendingPublication.sha') = ?",
      [work.branch, work.sha],
    ),
  ]);
  return results.at(-2)?.results.length === 1;
}

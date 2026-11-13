import type { D1Database } from "@cloudflare/workers-types";
import {
  planningPrompt,
  type PlanningAdmission,
  type PlanningReceipt,
} from "@/application/triggers/planning.ts";

export async function acceptPlanningInput(
  db: D1Database,
  input: PlanningAdmission,
): Promise<PlanningReceipt> {
  const scope = JSON.stringify([
    input.ownerId,
    input.projectId,
    input.repositoryId,
    input.issueNumber,
  ]);
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const result = await db.batch<PlanningReceipt>([
    db
      .prepare(`INSERT INTO sessions (id, owner_id, project_id, target, created_at)
      SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM planning_issues WHERE scope = ?)
      AND NOT EXISTS (SELECT 1 FROM planning_deliveries WHERE delivery_id = ?)`)
      .bind(
        sessionId,
        input.ownerId,
        input.projectId,
        JSON.stringify({
          version: 1,
          kind: "github.issue",
          repositoryId: input.repositoryId,
          issueNumber: input.issueNumber,
        }),
        now,
        scope,
        input.deliveryId,
      ),
    db
      .prepare(
        `INSERT INTO planning_issues (scope, session_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)`,
      )
      .bind(scope, sessionId, sessionId),
    db
      .prepare(`UPDATE planning_issues SET started = 1 WHERE scope = ? AND ? = 1
      AND NOT EXISTS (SELECT 1 FROM planning_deliveries WHERE delivery_id = ?)
      AND NOT EXISTS (SELECT 1 FROM planning_inbox WHERE scope = ? AND comment_id = ?)`)
      .bind(
        scope,
        input.start ? 1 : 0,
        input.deliveryId,
        scope,
        input.commentId,
      ),
    db
      .prepare(`INSERT INTO planning_inbox (scope, comment_id, actor, url, body, execution_context, timeout_ms, received_at, state)
      SELECT scope, ?, ?, ?, ?, ?, ?, ?, CASE WHEN started = 1 THEN 'pending' ELSE 'guidance' END FROM planning_issues
      WHERE scope = ? AND NOT EXISTS (SELECT 1 FROM planning_deliveries WHERE delivery_id = ?)
      ON CONFLICT (scope, comment_id) DO NOTHING`)
      .bind(
        input.commentId,
        input.actor,
        input.url,
        input.body,
        input.executionContext,
        input.timeoutMs,
        now,
        scope,
        input.deliveryId,
      ),
    db
      .prepare(`INSERT INTO planning_deliveries (delivery_id, input_id)
      SELECT ?, id FROM planning_inbox WHERE scope = ? AND comment_id = ? ON CONFLICT DO NOTHING`)
      .bind(input.deliveryId, scope, input.commentId),
    db
      .prepare(`INSERT INTO planning_replies (input_id, body, next_attempt_at)
      SELECT id, '計画を開始するには、Issue の新しいコメントで @tailos plan を送ってください。', 0 FROM planning_inbox
      WHERE scope = ? AND comment_id = ? AND state = 'guidance' ON CONFLICT DO NOTHING`)
      .bind(scope, input.commentId),
    db
      .prepare(`SELECT p.session_id AS sessionId, i.id AS inputId FROM planning_deliveries d
      JOIN planning_inbox i ON i.id = d.input_id JOIN planning_issues p ON p.scope = i.scope
      WHERE d.delivery_id = ? AND p.scope = ? AND i.comment_id = ?`)
      .bind(input.deliveryId, scope, input.commentId),
  ]);
  const receipt = result.at(-1)?.results[0];
  if (!receipt)
    throw new Error("Planning delivery does not match its original scope");
  return receipt;
}

// Each batch chooses the oldest persisted input, with the active-run constraint
// still enforced by runs. No network operation occurs inside this transaction.
export async function dispatchPlanningInputs(
  db: D1Database,
): Promise<string[]> {
  const due = await db
    .prepare(`SELECT p.scope FROM planning_issues p WHERE
    EXISTS (SELECT 1 FROM planning_inbox i WHERE i.scope = p.scope AND i.state = 'pending')
    AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id = p.session_id AND r.status IN ('queued', 'running'))
    ORDER BY (SELECT min(id) FROM planning_inbox WHERE scope = p.scope AND state = 'pending') LIMIT 25`)
    .all<{ scope: string }>();
  const ids: string[] = [];
  for (const { scope } of due.results) {
    const runId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const result = await db.batch<{ id: string }>([
      db
        .prepare(`INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at)
        SELECT ?, p.session_id, (SELECT coalesce(max(seq), 0) + 1 FROM session_messages WHERE session_id = p.session_id), 'automation', i.body, ?
        FROM planning_issues p JOIN planning_inbox i ON i.scope = p.scope WHERE p.scope = ? AND i.id =
        (SELECT min(id) FROM planning_inbox WHERE scope = p.scope AND state = 'pending')
        AND NOT EXISTS (SELECT 1 FROM runs WHERE session_id = p.session_id AND status IN ('queued', 'running'))`)
        .bind(messageId, now, scope),
      db
        .prepare(`INSERT INTO runs (id, session_id, start_message_id, status, concurrency_key, execution_context, deadline_at, next_action_at, created_at)
        SELECT ?, p.session_id, ?, 'queued', ?, i.execution_context, ? + i.timeout_ms, ?, ?
        FROM planning_issues p JOIN planning_inbox i ON i.scope = p.scope WHERE p.scope = ?
        AND i.id = (SELECT min(id) FROM planning_inbox WHERE scope = p.scope AND state = 'pending')
        AND EXISTS (SELECT 1 FROM session_messages WHERE id = ?)`)
        .bind(
          runId,
          messageId,
          `github.issue-plan/${scope}`,
          now,
          now,
          now,
          scope,
          messageId,
        ),
      db
        .prepare(
          `UPDATE planning_issues SET latest_run_id = ? WHERE scope = ? AND EXISTS (SELECT 1 FROM runs WHERE id = ?)`,
        )
        .bind(runId, scope, runId),
      db
        .prepare(
          `INSERT INTO issue_notifications (run_id, next_attempt_at) SELECT id, 0 FROM runs WHERE id = ?`,
        )
        .bind(runId),
      db
        .prepare(`UPDATE planning_inbox SET state = 'assigned', run_id = ? WHERE id =
        (SELECT min(id) FROM planning_inbox WHERE scope = ? AND state = 'pending')
        AND EXISTS (SELECT 1 FROM runs WHERE id = ?) RETURNING run_id AS id`)
        .bind(runId, scope, runId),
    ]);
    const id = result.at(-1)?.results[0]?.id;
    if (id) ids.push(id);
  }
  return ids;
}

export async function savePlanningSnapshot(
  db: D1Database,
  runId: string,
  issue: { title: string; body: string },
  baseSha: string,
) {
  const input = await db
    .prepare(`SELECT id, scope FROM planning_inbox WHERE run_id = ?`)
    .bind(runId)
    .first<{ id: number; scope: string }>();
  if (!input) return null;
  const history = await db
    .prepare(`SELECT i.id, i.actor, i.url, i.body, r.status, r.result, r.error_code AS errorCode,
    (SELECT body FROM session_messages WHERE run_id = i.run_id AND author_kind = 'agent') AS reply
    FROM planning_inbox i LEFT JOIN runs r ON r.id = i.run_id
    WHERE i.scope = ? AND i.id <= ? AND i.state != 'guidance' ORDER BY i.id`)
    .bind(input.scope, input.id)
    .all();
  // A snapshot is immutable even if an attempt to submit to Runner is interrupted.
  await db
    .prepare(`INSERT INTO planning_snapshots (run_id, input_id, title, body, base_sha, conversation, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(
      runId,
      input.id,
      issue.title,
      issue.body,
      baseSha,
      JSON.stringify(history.results),
      Date.now(),
    )
    .run();
  const snapshot = await db
    .prepare(
      `SELECT title, body, base_sha AS baseSha, conversation FROM planning_snapshots WHERE run_id = ?`,
    )
    .bind(runId)
    .first<{
      title: string;
      body: string;
      baseSha: string;
      conversation: string;
    }>();
  return (
    snapshot && {
      baseSha: snapshot.baseSha,
      prompt: planningPrompt,
      context: JSON.stringify({
        ...snapshot,
        conversation: JSON.parse(snapshot.conversation),
      }),
    }
  );
}

import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { diagnosticRetentionMs } from "@tailos/core/diagnostics";
import {
  ProjectChanged,
  type IssueMessage,
  type IssueMessageReceipt,
} from "@/application/triggers/admit-trigger.ts";
import type { SessionMessage } from "@/application/sessions/continue-session.ts";

/** A SQL expression for a Session ID, with its bindings. */
type SessionExpression = { sql: string; bindings: unknown[] };

/**
 * Turns the Session's oldest waiting message into a Turn, unless a Turn is in
 * progress or its Project is gone. The Turn's time limit starts now, not when
 * the message arrived.
 */
function startNext(
  db: D1Database,
  session: SessionExpression,
  runId: string,
  now: number,
): D1PreparedStatement[] {
  const messageId = crypto.randomUUID();
  const next = `(SELECT min(id) FROM session_inbox WHERE session_id = ${session.sql} AND run_id IS NULL)`;
  return [
    db
      .prepare(`INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at)
      SELECT ?, i.session_id, (SELECT coalesce(max(seq), 0) + 1 FROM session_messages WHERE session_id = i.session_id),
        i.author_kind, i.body, ?
      FROM session_inbox i JOIN sessions s ON s.id = i.session_id JOIN projects p ON p.id = s.project_id
      WHERE i.id = ${next} AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM runs WHERE session_id = i.session_id AND status IN ('queued', 'running'))`)
      .bind(messageId, now, ...session.bindings),
    db
      .prepare(`INSERT INTO runs (id, session_id, start_message_id, status, execution_context, deadline_at, next_action_at, created_at)
      SELECT ?, i.session_id, ?, 'queued', i.execution_context, ? + i.timeout_ms, ?, ?
      FROM session_inbox i WHERE i.id = ${next} AND EXISTS (SELECT 1 FROM session_messages WHERE id = ?)`)
      .bind(runId, messageId, now, now, now, ...session.bindings, messageId),
    db
      .prepare(
        `UPDATE session_inbox SET run_id = ? WHERE id = ${next} AND EXISTS (SELECT 1 FROM runs WHERE id = ?)`,
      )
      .bind(runId, ...session.bindings, runId),
    // Every Turn from an issue shows its state on the issue; a message sent
    // from the Session's page does not.
    db
      .prepare(
        `INSERT INTO issue_notifications (run_id, next_attempt_at)
        SELECT r.id, ? FROM runs r JOIN session_inbox i ON i.run_id = r.id
        WHERE r.id = ? AND i.source != 'web.message'
          AND json_extract(r.execution_context, '$.trigger.issueNumber') IS NOT NULL`,
      )
      .bind(now, runId),
    db
      .prepare(`INSERT INTO diagnostic_traces (id, owner_id, session_id, run_id, source, created_at, expires_at)
      SELECT 'run/' || r.id, s.owner_id, r.session_id, r.id, 'run', r.created_at, r.created_at + ?
      FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?`)
      .bind(diagnosticRetentionMs, runId),
    db
      .prepare(`INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, occurred_at, received_at, name, attributes)
      SELECT 'run/' || id || '/admitted', 'run/' || id, 'run/' || id, 'database', created_at, created_at, 'run.admitted',
      json_object('outcome', status, 'deadlineAt', deadline_at, 'engine', CASE WHEN json_valid(execution_context) THEN json_extract(execution_context, '$.engine') ELSE NULL END)
      FROM runs WHERE id = ?`)
      .bind(runId),
  ];
}

/**
 * Adds a message to the Session its Routine keeps for the issue, creating the
 * Session for a message that may start one. The message becomes a Turn at
 * once if the Session has none in progress; otherwise it waits.
 */
export async function admitIssueMessage(
  db: D1Database,
  input: IssueMessage,
): Promise<IssueMessageReceipt | null> {
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const now = Date.now();
  const requestId = input.diagnostics?.requestId ?? crypto.randomUUID();
  const traceId = input.diagnostics?.traceId ?? `request/${requestId}`;
  const key =
    "owner_id = ? AND project_id = ? AND routine_id = ? AND repository_id = ? AND issue_number = ?";
  const keyBindings = [
    input.ownerId,
    input.projectId,
    input.routineId,
    input.repositoryId,
    input.issueNumber,
  ];
  const delivered =
    "EXISTS (SELECT 1 FROM session_inbox WHERE source = ? AND idempotency_key = ?)";
  const deliveryBindings = [input.source, input.idempotencyKey];
  // Settings changed since they were read: the caller reads them again.
  const current = `EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_id = ? AND revision = ? AND deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM routines WHERE id = ? AND project_id = ? AND revision = ? AND deleted_at IS NULL
      AND json_extract(config, '$.enabled') = 1)`;
  const currentBindings = [
    input.projectId,
    input.ownerId,
    input.projectRevision,
    input.routineId,
    input.projectId,
    input.routineRevision,
  ];
  const session: SessionExpression = {
    sql: "(SELECT session_id FROM session_inbox WHERE source = ? AND idempotency_key = ?)",
    bindings: deliveryBindings,
  };
  const results = await db.batch<
    | { sessionId: string; runId: string | null }
    | { current: number; delivered: number }
    | { id: string }
  >([
    db
      .prepare(`INSERT INTO sessions (id, owner_id, project_id, target, title, trigger_metadata, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ? = 1 AND NOT EXISTS (SELECT 1 FROM routine_sessions WHERE ${key})
        AND NOT ${delivered} AND ${current}`)
      .bind(
        sessionId,
        input.ownerId,
        input.projectId,
        input.target,
        input.initialTitle,
        input.triggerMetadata,
        now,
        input.startsSession ? 1 : 0,
        ...keyBindings,
        ...deliveryBindings,
        ...currentBindings,
      ),
    db
      .prepare(`INSERT INTO routine_sessions (owner_id, project_id, routine_id, repository_id, issue_number, session_id, last_message_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?) ON CONFLICT DO NOTHING`)
      .bind(...keyBindings, sessionId, now, sessionId),
    db
      .prepare(`INSERT INTO session_inbox (session_id, source, idempotency_key, delivery_id, routine_id, routine_revision,
        author_kind, body, execution_context, timeout_ms, received_at)
      SELECT session_id, ?, ?, ?, ?, ?, 'automation', ?, ?, ?, ? FROM routine_sessions
      WHERE ${key} AND NOT ${delivered} AND ${current}
      ON CONFLICT (source, idempotency_key) DO NOTHING`)
      .bind(
        ...deliveryBindings,
        input.deliveryId,
        input.routineId,
        input.routineRevision,
        input.body,
        input.executionContext,
        input.timeoutMs,
        now,
        ...keyBindings,
        ...deliveryBindings,
        ...currentBindings,
      ),
    db
      .prepare(`UPDATE routine_sessions SET last_message_at = ? WHERE ${key}
      AND EXISTS (SELECT 1 FROM session_inbox WHERE source = ? AND idempotency_key = ? AND received_at = ?)`)
      .bind(now, ...keyBindings, ...deliveryBindings, now),
    ...startNext(db, session, runId, now),
    db
      .prepare(`INSERT INTO diagnostic_traces (id, owner_id, session_id, source, delivery_id, request_id, created_at, expires_at)
      SELECT ?, s.owner_id, i.session_id, ?, ?, ?, ?, ? FROM session_inbox i JOIN sessions s ON s.id = i.session_id
      WHERE i.source = ? AND i.idempotency_key = ? AND s.owner_id = ? ON CONFLICT(id) DO NOTHING`)
      .bind(
        traceId,
        input.source,
        input.deliveryId,
        requestId,
        now,
        now + diagnosticRetentionMs,
        ...deliveryBindings,
        input.ownerId,
      ),
    db
      .prepare(`INSERT INTO diagnostic_links (from_trace, to_trace, relation)
      SELECT ?, 'run/' || i.run_id, CASE WHEN i.received_at = ? THEN 'starts' ELSE 'replays' END
      FROM session_inbox i JOIN sessions s ON s.id = i.session_id
      WHERE i.source = ? AND i.idempotency_key = ? AND s.owner_id = ? AND i.run_id IS NOT NULL
      ON CONFLICT DO NOTHING`)
      .bind(traceId, now, ...deliveryBindings, input.ownerId),
    db
      .prepare(`INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, request_id, occurred_at, received_at, name, attributes)
      SELECT ?, ?, ?, 'api', ?, ?, ?, 'trigger.decided',
        json_object('outcome', CASE WHEN i.received_at != ? THEN 'replayed' WHEN i.run_id IS NULL THEN 'queued' ELSE 'started' END,
          'routineId', i.routine_id)
      FROM session_inbox i JOIN sessions s ON s.id = i.session_id
      WHERE i.source = ? AND i.idempotency_key = ? AND s.owner_id = ?`)
      .bind(
        crypto.randomUUID(),
        traceId,
        traceId,
        requestId,
        now,
        now,
        now,
        ...deliveryBindings,
        input.ownerId,
      ),
    db
      .prepare(`SELECT i.session_id AS sessionId, i.run_id AS runId FROM session_inbox i
      JOIN sessions s ON s.id = i.session_id WHERE i.source = ? AND i.idempotency_key = ? AND s.owner_id = ?`)
      .bind(...deliveryBindings, input.ownerId),
    db
      .prepare(`SELECT (${current}) AS current, ${delivered} AS delivered`)
      .bind(...currentBindings, ...deliveryBindings),
    db.prepare(`SELECT id FROM runs WHERE id = ?`).bind(runId),
  ]);
  const started = results.at(-1)?.results[0];
  const state = results.at(-2)?.results[0];
  const row = results.at(-3)?.results[0];
  if (row && "sessionId" in row)
    return {
      sessionId: row.sessionId,
      ...(row.runId && { runId: row.runId }),
      disposition: row.runId ? "started" : "queued",
      ...(started && "id" in started && { started: started.id }),
    };
  if (state && "delivered" in state && state.delivered)
    throw new Error("Trigger delivery does not match its original owner");
  if (state && "current" in state && state.current === 0)
    throw new ProjectChanged("Project changed before admission");
  if (!input.startsSession) return null;
  throw new Error("Trigger admission did not complete");
}

/**
 * Starts the next Turn of Sessions whose messages wait with no Turn in
 * progress, such as after a Turn ends. Returns the Turns to schedule.
 */
export async function dispatchSessionInbox(db: D1Database): Promise<string[]> {
  const due = await db
    .prepare(`SELECT i.session_id AS sessionId FROM session_inbox i
    JOIN sessions s ON s.id = i.session_id JOIN projects p ON p.id = s.project_id
    WHERE i.run_id IS NULL AND p.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM runs WHERE session_id = i.session_id AND status IN ('queued', 'running'))
    GROUP BY i.session_id ORDER BY min(i.id) LIMIT 25`)
    .all<{ sessionId: string }>();
  const ids: string[] = [];
  for (const { sessionId } of due.results) {
    const runId = crypto.randomUUID();
    const result = await db.batch<{ id: string }>([
      ...startNext(db, { sql: "?", bindings: [sessionId] }, runId, Date.now()),
      db.prepare("SELECT id FROM runs WHERE id = ?").bind(runId),
    ]);
    const id = result.at(-1)?.results[0]?.id;
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * The Session a comment without a command continues: the one most recently
 * given a message among the issue's Sessions of comment Routines.
 */
export async function latestCommentSession(
  db: D1Database,
  input: {
    ownerId: string;
    projectId: string;
    repositoryId: number;
    issueNumber: number;
  },
) {
  return db
    .prepare(`SELECT rs.routine_id AS routineId FROM routine_sessions rs JOIN routines r ON r.id = rs.routine_id
    WHERE rs.owner_id = ? AND rs.project_id = ? AND rs.repository_id = ? AND rs.issue_number = ?
      AND json_extract(r.config, '$.trigger.type') = 'github.issue-comment'
    ORDER BY rs.last_message_at DESC LIMIT 1`)
    .bind(input.ownerId, input.projectId, input.repositoryId, input.issueNumber)
    .first<{ routineId: string }>();
}

/** The execution settings of a Session's latest Turn, for its next one. */
export async function latestTurnContext(
  db: D1Database,
  input: { ownerId: string; projectId: string; sessionId: string },
) {
  return db
    .prepare(`SELECT r.execution_context AS context FROM runs r JOIN sessions s ON s.id = r.session_id
    WHERE s.id = ? AND s.owner_id = ? AND s.project_id = ?
    ORDER BY r.created_at DESC, r.id DESC LIMIT 1`)
    .bind(input.sessionId, input.ownerId, input.projectId)
    .first<string>("context");
}

/**
 * Adds the owner's message to a Session that is not working, and makes it
 * the Session's next Turn at once. A resend of the same request returns the
 * first result.
 */
export async function admitSessionMessage(
  db: D1Database,
  input: SessionMessage,
): Promise<{ runId: string } | "busy" | "not_found"> {
  const runId = crypto.randomUUID();
  const now = Date.now();
  const delivery = [
    "web.message",
    JSON.stringify([input.ownerId, input.sessionId, input.requestId]),
  ];
  const working = `(EXISTS (SELECT 1 FROM runs WHERE session_id = s.id AND status IN ('queued', 'running'))
    OR EXISTS (SELECT 1 FROM session_inbox WHERE session_id = s.id AND run_id IS NULL))`;
  const owned = `FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.id = ? AND s.owner_id = ? AND p.id = ? AND p.owner_id = ? AND p.deleted_at IS NULL`;
  const ownedBindings = [
    input.sessionId,
    input.ownerId,
    input.projectId,
    input.ownerId,
  ];
  const results = await db.batch<
    { runId: string | null } | { current: number; working: number }
  >([
    db
      .prepare(`INSERT INTO session_inbox (session_id, source, idempotency_key, delivery_id, author_kind, body,
        execution_context, timeout_ms, received_at)
      SELECT s.id, ?, ?, ?, 'user', ?, ?, ?, ? ${owned} AND p.revision = ? AND NOT ${working}
      ON CONFLICT (source, idempotency_key) DO NOTHING`)
      .bind(
        ...delivery,
        input.requestId,
        input.body,
        input.executionContext,
        input.timeoutMs,
        now,
        ...ownedBindings,
        input.projectRevision,
      ),
    ...startNext(db, { sql: "?", bindings: [input.sessionId] }, runId, now),
    db
      .prepare(`SELECT i.run_id AS runId FROM session_inbox i JOIN sessions s ON s.id = i.session_id
      WHERE i.source = ? AND i.idempotency_key = ? AND s.owner_id = ?`)
      .bind(...delivery, input.ownerId),
    db
      .prepare(
        `SELECT p.revision = ? AS current, ${working} AS working ${owned}`,
      )
      .bind(input.projectRevision, ...ownedBindings),
  ]);
  const state = results.at(-1)?.results[0];
  const row = results.at(-2)?.results[0];
  if (row && "runId" in row) return row.runId ? { runId: row.runId } : "busy";
  if (!state || !("current" in state)) return "not_found";
  if (state.current === 0)
    throw new ProjectChanged("Project changed before the message");
  return "busy";
}

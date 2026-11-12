import type { D1Database } from "@cloudflare/workers-types";
import { diagnosticRetentionMs } from "@tailos/core/diagnostics";

import type {
  Admission,
  TriggerAdmission,
} from "@/application/triggers/admit-trigger.ts";

export async function admitTrigger(
  db: D1Database,
  input: TriggerAdmission,
): Promise<Admission> {
  const sessionId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const now = Date.now();
  const triggerId = crypto.randomUUID();
  const requestId = input.diagnostics?.requestId ?? crypto.randomUUID();
  const traceId = input.diagnostics?.traceId ?? `request/${requestId}`;
  // D1 serializes the batch. Only the transaction that inserts this session ID
  // writes its initial message and run. The event always refers to the winner.
  const scope = JSON.stringify([input.ownerId, input.concurrencyKey]);
  const active = "concurrency_key = ? AND status IN ('queued', 'running')";
  const delivery = "source = ? AND idempotency_key = ?";
  const created = "EXISTS (SELECT 1 FROM sessions WHERE id = ?)";

  const results = await db.batch<Admission>([
    db
      .prepare(
        `INSERT INTO sessions (id, owner_id, project_id, target, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM trigger_events WHERE ${delivery})
         AND NOT EXISTS (SELECT 1 FROM runs WHERE ${active})`,
      )
      .bind(
        sessionId,
        input.ownerId,
        input.projectId ?? null,
        input.target ?? null,
        now,
        input.source,
        input.idempotencyKey,
        scope,
      ),
    db
      .prepare(
        `INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at)
       SELECT ?, ?, 1, 'automation', ?, ? WHERE ${created}`,
      )
      .bind(messageId, sessionId, input.prompt, now, sessionId),
    db
      .prepare(
        `INSERT INTO runs (id, session_id, start_message_id, status, concurrency_key,
                         execution_context, deadline_at, created_at, next_action_at)
       SELECT ?, ?, ?, 'queued', ?, ?, ?, ?, ? WHERE ${created}`,
      )
      .bind(
        runId,
        sessionId,
        messageId,
        scope,
        input.executionContext,
        now + input.timeoutMs,
        now,
        now,
        sessionId,
      ),
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
    db
      .prepare(
        `INSERT INTO trigger_events (id, run_id, source, idempotency_key, disposition, received_at)
       SELECT ?, id, ?, ?, CASE WHEN id = ? THEN 'started' ELSE 'coalesced' END, ?
       FROM runs WHERE ${active}
       ON CONFLICT (source, idempotency_key) DO NOTHING`,
      )
      .bind(triggerId, input.source, input.idempotencyKey, runId, now, scope),
    // The winning run may have been admitted by the previous Worker after the
    // migration. Backfill only facts that are present in its business rows.
    db
      .prepare(`INSERT INTO diagnostic_traces (id, owner_id, session_id, run_id, source, created_at, expires_at)
      SELECT 'run/' || r.id, s.owner_id, r.session_id, r.id, 'run', r.created_at, ?
      FROM trigger_events e JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id
      WHERE e.source = ? AND e.idempotency_key = ? AND s.owner_id = ? ON CONFLICT(id) DO NOTHING`)
      .bind(
        now + diagnosticRetentionMs,
        input.source,
        input.idempotencyKey,
        input.ownerId,
      ),
    db
      .prepare(`INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, occurred_at, received_at, name, attributes)
      SELECT 'snapshot/' || r.id, 'run/' || r.id, 'run/' || r.id, 'database', ?, ?, 'run.snapshot',
        json_object('evidence', 'state_snapshot', 'outcome', r.status, 'errorCode', r.error_code)
      FROM trigger_events e JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id
      WHERE e.source = ? AND e.idempotency_key = ? AND s.owner_id = ? AND changes() = 1 ON CONFLICT(event_id) DO NOTHING`)
      .bind(now, now, input.source, input.idempotencyKey, input.ownerId),
    db
      .prepare(`INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, occurred_at, received_at, name, attributes)
      SELECT 'trigger/' || e.id, 'run/' || e.run_id, 'run/' || e.run_id, 'database', e.received_at, e.received_at, 'trigger.admitted',
      json_object('source', e.source, 'deliveryId', e.idempotency_key, 'outcome', e.disposition)
      FROM trigger_events e JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id
      WHERE e.source = ? AND e.idempotency_key = ? AND s.owner_id = ? ON CONFLICT(event_id) DO NOTHING`)
      .bind(input.source, input.idempotencyKey, input.ownerId),
    db
      .prepare(`INSERT INTO diagnostic_traces
       (id, owner_id, session_id, source, delivery_id, request_id, created_at, expires_at)
       SELECT ?, sessions.owner_id, runs.session_id, ?, ?, ?, ?, ?
       FROM trigger_events e JOIN runs ON runs.id = e.run_id JOIN sessions ON sessions.id = runs.session_id
       WHERE e.source = ? AND e.idempotency_key = ? AND sessions.owner_id = ?
       ON CONFLICT(id) DO NOTHING`)
      .bind(
        traceId,
        input.source,
        input.idempotencyKey,
        requestId,
        now,
        now + diagnosticRetentionMs,
        input.source,
        input.idempotencyKey,
        input.ownerId,
      ),
    db
      .prepare(`INSERT INTO diagnostic_links (from_trace, to_trace, relation)
       SELECT ?, 'run/' || e.run_id,
         CASE WHEN e.id != ? THEN 'replays' WHEN e.disposition = 'started' THEN 'starts' ELSE 'coalesces' END
       FROM trigger_events e JOIN runs ON runs.id = e.run_id JOIN sessions ON sessions.id = runs.session_id
       WHERE e.source = ? AND e.idempotency_key = ? AND sessions.owner_id = ?
       ON CONFLICT DO NOTHING`)
      .bind(
        traceId,
        triggerId,
        input.source,
        input.idempotencyKey,
        input.ownerId,
      ),
    db
      .prepare(`INSERT INTO diagnostic_events
       (event_id, trace_id, span_id, producer_id, request_id, occurred_at, received_at, name, attributes)
       SELECT ?, ?, ?, 'api', ?, ?, ?, 'trigger.decided',
         json_object('outcome', CASE WHEN e.id != ? THEN 'replayed' ELSE e.disposition END)
       FROM trigger_events e JOIN runs ON runs.id = e.run_id JOIN sessions ON sessions.id = runs.session_id
       WHERE e.source = ? AND e.idempotency_key = ? AND sessions.owner_id = ?`)
      .bind(
        crypto.randomUUID(),
        traceId,
        traceId,
        requestId,
        now,
        now,
        triggerId,
        input.source,
        input.idempotencyKey,
        input.ownerId,
      ),
    db
      .prepare(
        `SELECT runs.session_id AS sessionId, trigger_events.run_id AS runId, disposition
       FROM trigger_events JOIN runs ON runs.id = trigger_events.run_id
       JOIN sessions ON sessions.id = runs.session_id
       WHERE ${delivery} AND sessions.owner_id = ?`,
      )
      .bind(input.source, input.idempotencyKey, input.ownerId),
  ]);
  const admission = results.at(-1)?.results[0];
  if (!admission)
    throw new Error("Trigger delivery does not match its original owner");
  return admission;
}

import type { D1Database } from "@cloudflare/workers-types";
import { diagnosticRetentionMs, runTraceId } from "@tailos/core/diagnostics";
import type { RunStatus } from "@/application/runs/advance-run.ts";

// Also covers runs admitted by the previous Worker between migration and code
// rollout. A snapshot is explicitly an observation, never an invented start.
export function ensureRunTrace(db: D1Database, runId: string, now: number) {
  return [
    db
      .prepare(`INSERT INTO diagnostic_traces (id, owner_id, session_id, run_id, source, created_at, expires_at)
      SELECT 'run/' || r.id, s.owner_id, r.session_id, r.id, 'run', r.created_at, ?
      FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ? AND r.status IN ('queued', 'running')
      ON CONFLICT(id) DO NOTHING`)
      .bind(now + diagnosticRetentionMs, runId),
    db
      .prepare(`INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, occurred_at, received_at, name, attributes)
      SELECT 'snapshot/' || id, 'run/' || id, 'run/' || id, 'database', ?, ?, 'run.snapshot',
        json_object('evidence', 'state_snapshot', 'outcome', status, 'errorCode', error_code)
      FROM runs WHERE id = ? AND changes() = 1 ON CONFLICT(event_id) DO NOTHING`)
      .bind(now, now, runId),
  ];
}

// Execute in the same D1 batch immediately before the conditional business
// write. Matching predicates make a competing claim create neither a state
// transition nor an event; any journal error rolls back the whole batch.
export function executionTransition(
  db: D1Database,
  runId: string,
  from: RunStatus,
  to: RunStatus,
  at: number,
  errorCode: string | null = null,
  result: string | null = null,
) {
  return db
    .prepare(`INSERT INTO diagnostic_events
    (event_id, trace_id, span_id, producer_id, occurred_at, received_at, name, attributes)
    SELECT ?, ?, ?, 'database', ?, ?, ?, ? FROM runs WHERE id = ? AND status = ?
    ON CONFLICT(event_id) DO NOTHING`)
    .bind(
      `${runTraceId(runId)}/${to}`,
      runTraceId(runId),
      runTraceId(runId),
      at,
      at,
      to === "running" ? "run.started" : "run.finished",
      JSON.stringify({
        outcome: to,
        errorCode,
        result: result === null ? null : JSON.parse(result),
      }),
      runId,
      from,
    );
}

export function publicationEvent(
  db: D1Database,
  runId: string,
  eventId: string,
  name: string,
  at: number,
  attributes: object,
  predicate: string,
  bindings: (string | number)[],
) {
  return db
    .prepare(`INSERT INTO diagnostic_events
    (event_id, trace_id, span_id, producer_id, occurred_at, received_at, name, attributes)
    SELECT ?, ?, ?, 'database', ?, ?, ?, ? FROM runs WHERE id = ? AND status = 'running' AND ${predicate}
    ON CONFLICT(event_id) DO NOTHING`)
    .bind(
      eventId,
      runTraceId(runId),
      runTraceId(runId),
      at,
      at,
      name,
      JSON.stringify(attributes),
      runId,
      ...bindings,
    );
}

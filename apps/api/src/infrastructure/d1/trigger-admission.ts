import type { D1Database } from "@cloudflare/workers-types";

import type {
  Admission,
  TriggerAdmission,
} from "#api/application/triggers/admit-trigger.ts";

export async function admitTrigger(
  db: D1Database,
  input: TriggerAdmission,
): Promise<Admission> {
  const sessionId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const now = Date.now();
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
      .prepare(
        `INSERT INTO trigger_events (id, run_id, source, idempotency_key, disposition, received_at)
       SELECT ?, id, ?, ?, CASE WHEN id = ? THEN 'started' ELSE 'coalesced' END, ?
       FROM runs WHERE ${active}
       ON CONFLICT (source, idempotency_key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        input.source,
        input.idempotencyKey,
        runId,
        now,
        scope,
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
  const admission = results[4]?.results[0];
  if (!admission)
    throw new Error("Trigger delivery does not match its original owner");
  return admission;
}

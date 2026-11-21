import type { D1Database } from "@cloudflare/workers-types";
import {
  timelineRecord,
  timelineMarker,
  timelineNotification,
} from "@/infrastructure/d1/timeline.ts";
import {
  DiagnosticBatch,
  diagnosticBodyRetentionMs,
  diagnosticGraceMs,
  diagnosticRetentionMs,
  maxDiagnosticBatch,
  maxDiagnosticBytes,
  runTraceId,
  type DiagnosticAttributes,
} from "@tailos/core/diagnostics";
import { redactDiagnosticBody } from "@tailos/diagnostics";
import * as v from "valibot";
import type {
  DiagnosticReader,
  DiagnosticEventView,
  DiagnosticArtifactView,
  DiagnosticTraceView,
  TriggerDiagnostic,
} from "@/application/diagnostics/store.ts";
import { DiagnosticStorageLimit } from "@/application/diagnostics/store.ts";
import type { RunArtifactsBucket } from "@/infrastructure/r2/run-artifacts.ts";

export async function digestDiagnostic(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function canIngestDiagnostics(
  db: D1Database,
  runId: string,
  now: number,
) {
  return Boolean(
    await db
      .prepare(
        "SELECT 1 FROM runs WHERE id = ? AND deadline_at + ? > ? AND (finished_at IS NULL OR finished_at + ? > ?)",
      )
      .bind(runId, diagnosticGraceMs, now, diagnosticGraceMs, now)
      .first(),
  );
}

export async function registerDiagnosticProducer(
  db: D1Database,
  runId: string,
  producerId: string,
) {
  const result = await db
    .prepare(`UPDATE diagnostic_traces SET producer_id = ?, capture_state = 'collecting'
    WHERE id = ? AND (producer_id IS NULL OR producer_id = ?)`)
    .bind(producerId, runTraceId(runId), producerId)
    .run();
  if (result.meta.changes !== 1)
    throw new Error("Diagnostic producer unavailable");
}

export async function ingestDiagnostics(
  db: D1Database,
  bucket: RunArtifactsBucket,
  runId: string,
  producerId: string,
  input: DiagnosticBatch,
  secrets: Iterable<string> = [],
) {
  const batch = v.parse(DiagnosticBatch, input);
  if (batch.producerId !== producerId)
    throw new Error("Diagnostic producer mismatch");
  const records = [];
  for (const record of batch.records) {
    records.push({
      ...record,
      ...(record.body === undefined
        ? {}
        : { body: await redactDiagnosticBody(record.body, secrets) }),
    });
  }
  const safeBatch = { ...batch, records };
  const content = JSON.stringify(safeBatch);
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > maxDiagnosticBatch) throw new Error("Diagnostic batch too large");
  const digest = await digestDiagnostic(content);
  const traceId = runTraceId(runId);
  const existing = await db
    .prepare(
      "SELECT digest, trace_id AS traceId FROM diagnostic_artifacts WHERE id = ?",
    )
    .bind(batch.batchId)
    .first<{ digest: string; traceId: string }>();
  if (existing) {
    if (existing.digest !== digest || existing.traceId !== traceId)
      throw new Error("Diagnostic batch conflict");
    return;
  }
  const trace = await db
    .prepare(
      "SELECT producer_id AS producerId, last_seq AS lastSeq, dropped, body_bytes AS bodyBytes FROM diagnostic_traces WHERE id = ? AND expires_at > ?",
    )
    .bind(traceId, Date.now())
    .first<{
      producerId: string | null;
      lastSeq: number | null;
      dropped: number;
      bodyBytes: number;
    }>();
  const lastSeq = trace?.lastSeq;
  if (
    trace?.producerId !== producerId ||
    (lastSeq != null &&
      (batch.records.some((r) => r.seq > lastSeq) ||
        (batch.completed &&
          (batch.completed.lastSeq !== lastSeq ||
            batch.completed.dropped !== trace.dropped))))
  )
    throw new Error("Diagnostic capture closed");
  // Keep space for the final marker even if the last detail packet cannot fit.
  const quota = batch.completed
    ? maxDiagnosticBytes
    : maxDiagnosticBytes - 1024;
  if (trace.bodyBytes + bytes > quota) throw new DiagnosticStorageLimit();
  const now = Date.now();
  const objectKey = `diagnostics/v1/${traceId}/${batch.batchId}-${digest}.json`;
  await bucket.put(objectKey, content);
  const statements = [
    db
      .prepare(`INSERT INTO diagnostic_artifacts (id, trace_id, span_id, object_key, digest, bytes, expires_at)
      SELECT ?, id, id, ?, ?, ?, ? FROM diagnostic_traces
      WHERE id = ? AND producer_id = ? AND body_bytes + ? <= ?
      AND (last_seq IS NULL OR last_seq >= ?)
      ON CONFLICT(id) DO UPDATE SET digest = CASE WHEN digest = excluded.digest AND trace_id = excluded.trace_id THEN digest ELSE NULL END`)
      .bind(
        batch.batchId,
        objectKey,
        digest,
        bytes,
        now + diagnosticBodyRetentionMs,
        traceId,
        producerId,
        bytes,
        quota,
        Math.max(0, ...batch.records.map((r) => r.seq)),
      ),
    db
      .prepare(`UPDATE diagnostic_traces SET body_bytes = (SELECT coalesce(sum(bytes), 0) FROM diagnostic_artifacts WHERE trace_id = ?)
      WHERE id = ?`)
      .bind(traceId, traceId),
  ];
  for (const record of records) {
    statements.push(
      db
        .prepare(`INSERT INTO diagnostic_events
      (event_id, trace_id, span_id, parent_span_id, producer_id, producer_seq, request_id, occurred_at, received_at, name, attributes, fingerprint, artifact_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM diagnostic_artifacts WHERE id = ? AND trace_id = ? AND digest = ?)
      ON CONFLICT(event_id) DO UPDATE SET fingerprint = CASE WHEN fingerprint = excluded.fingerprint AND trace_id = excluded.trace_id AND producer_id = excluded.producer_id THEN fingerprint ELSE NULL END`)
        .bind(
          record.eventId,
          traceId,
          record.spanId,
          record.parentSpanId ?? null,
          producerId,
          record.seq,
          record.requestId ?? null,
          record.at,
          now,
          record.name,
          JSON.stringify(record.attributes),
          await digestDiagnostic(JSON.stringify(record)),
          record.body === undefined ? null : batch.batchId,
          batch.batchId,
          traceId,
          digest,
        ),
    );
    statements.push(...timelineRecord(db, runId, batch.batchId, record, now));
  }
  if (batch.completed) {
    statements.push(
      timelineMarker(db, runId, `capture/${batch.batchId}`, "capture", now),
    );
    statements.push(
      db
        .prepare(`UPDATE diagnostic_traces SET last_seq = ?, dropped = ?
      WHERE id = ? AND (last_seq IS NULL OR last_seq = ?)
      AND EXISTS (SELECT 1 FROM diagnostic_artifacts WHERE id = ? AND trace_id = ? AND digest = ?)`)
        .bind(
          batch.completed.lastSeq,
          batch.completed.dropped,
          traceId,
          batch.completed.lastSeq,
          batch.batchId,
          traceId,
          digest,
        ),
    );
  }
  statements.push(
    db
      .prepare(`UPDATE diagnostic_traces SET capture_state = CASE
    WHEN last_seq IS NULL THEN 'collecting'
    WHEN dropped > 0 THEN 'partial'
    WHEN last_seq = (SELECT count(*) FROM diagnostic_events WHERE trace_id = ? AND producer_id = ?) THEN 'complete'
    ELSE 'partial' END WHERE id = ?`)
      .bind(traceId, producerId, traceId),
  );
  statements.push(timelineNotification(db, runId));
  await db.batch(statements);
  const stored = await db
    .prepare(
      "SELECT digest FROM diagnostic_artifacts WHERE id = ? AND trace_id = ?",
    )
    .bind(batch.batchId, traceId)
    .first<string>("digest");
  if (stored !== digest) throw new DiagnosticStorageLimit();
}

export async function recordTriggerDecision(
  db: D1Database,
  input: TriggerDiagnostic,
) {
  const now = Date.now();
  await db.batch([
    db
      .prepare(`INSERT INTO diagnostic_traces (id, source, delivery_id, request_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(
        input.traceId,
        input.source,
        input.deliveryId ?? null,
        input.requestId,
        now,
        now + diagnosticRetentionMs,
      ),
    db
      .prepare(`INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, request_id, occurred_at, received_at, name, attributes)
      VALUES (?, ?, ?, 'api', ?, ?, ?, 'trigger.decided', ?)`)
      .bind(
        crypto.randomUUID(),
        input.traceId,
        input.traceId,
        input.requestId,
        now,
        now,
        JSON.stringify({
          outcome: input.outcome ?? "ignored",
          reason: input.reason,
          ...(input.routineId && { routineId: input.routineId }),
        }),
      ),
  ]);
}

export async function recordRunDiagnostic(
  db: D1Database,
  runId: string,
  spanId: string,
  name: string,
  attributes: DiagnosticAttributes,
  parentSpanId = runTraceId(runId),
) {
  try {
    const now = Date.now();
    await db
      .prepare(`INSERT INTO diagnostic_events (event_id, trace_id, span_id, parent_span_id, producer_id, occurred_at, received_at, name, attributes)
      SELECT ?, id, ?, ?, 'controller', ?, ?, ?, ? FROM diagnostic_traces WHERE id = ?`)
      .bind(
        crypto.randomUUID(),
        spanId,
        parentSpanId,
        now,
        now,
        name,
        JSON.stringify(attributes),
        runTraceId(runId),
      )
      .run();
  } catch {
    // oxlint-disable-next-line no-console -- IDs only; telemetry must not mask the operation's result.
    console.warn("Diagnostic write failed", { runId });
  }
}

export async function observeRun<T>(
  db: D1Database,
  runId: string,
  operation: NonNullable<DiagnosticAttributes["operation"]>,
  execute: () => Promise<T>,
  classify: (result: T) => NonNullable<DiagnosticAttributes["outcome"]> = () =>
    "succeeded",
) {
  const spanId = crypto.randomUUID();
  const start = performance.now();
  await recordRunDiagnostic(db, runId, spanId, "span.started", { operation });
  try {
    const result = await execute();
    await recordRunDiagnostic(db, runId, spanId, "span.finished", {
      operation,
      outcome: classify(result),
      durationMs: performance.now() - start,
    });
    return result;
  } catch (error) {
    await recordRunDiagnostic(db, runId, spanId, "span.finished", {
      operation,
      outcome: "unknown",
      durationMs: performance.now() - start,
    });
    throw error;
  }
}

export function diagnosticReader(
  db: D1Database,
  bucket?: RunArtifactsBucket,
): DiagnosticReader {
  const owned = (ownerId: string, traceId: string) =>
    db
      .prepare(
        "SELECT id FROM diagnostic_traces WHERE id = ? AND (owner_id = ? OR owner_id IS NULL) AND expires_at > ?",
      )
      .bind(traceId, ownerId, Date.now())
      .first();
  return {
    async traces(ownerId, filter) {
      const clauses = [
        "(t.owner_id = ? OR t.owner_id IS NULL)",
        "t.expires_at > ?",
      ];
      const values: (string | number)[] = [ownerId, Date.now()];
      if (filter.runId) {
        clauses.push(
          "(t.run_id = ? OR t.id IN (SELECT from_trace FROM diagnostic_links WHERE to_trace = ?))",
        );
        values.push(filter.runId, runTraceId(filter.runId));
      }
      if (filter.source) {
        clauses.push("t.source = ?");
        values.push(filter.source);
      }
      if (filter.deliveryId) {
        clauses.push("t.delivery_id = ?");
        values.push(filter.deliveryId);
      }
      if (filter.before) {
        clauses.push("(t.created_at < ? OR (t.created_at = ? AND t.id < ?))");
        values.push(filter.before.at, filter.before.at, filter.before.id);
      }
      const result = await db
        .prepare(`SELECT t.id, t.run_id AS runId, t.session_id AS sessionId, t.source, t.delivery_id AS deliveryId,
        t.request_id AS requestId, t.created_at AS createdAt,
        CASE WHEN t.capture_state = 'collecting' AND r.finished_at IS NOT NULL AND r.finished_at + 120000 < ? THEN 'unknown' ELSE t.capture_state END AS captureState,
        t.dropped, r.status AS runStatus FROM diagnostic_traces t LEFT JOIN runs r ON r.id = t.run_id WHERE ${clauses.join(" AND ")} ORDER BY t.created_at DESC, t.id DESC LIMIT 51`)
        .bind(Date.now(), ...values)
        .all<DiagnosticTraceView>();
      const traces = result.results.slice(0, 50);
      const last = traces.at(-1);
      return {
        traces,
        nextCursor:
          result.results.length > 50 && last
            ? `${last.createdAt}:${last.id}`
            : null,
      };
    },
    async events(ownerId, traceId, after) {
      if (!(await owned(ownerId, traceId))) return null;
      const result = await db
        .prepare(`SELECT ingest_seq AS cursor, event_id AS eventId, span_id AS spanId, parent_span_id AS parentSpanId,
        producer_id AS producerId, producer_seq AS producerSeq, request_id AS requestId, occurred_at AS occurredAt,
        received_at AS receivedAt, name, attributes, artifact_id AS artifactId FROM diagnostic_events WHERE trace_id = ? AND ingest_seq > ? ORDER BY ingest_seq LIMIT 100`)
        .bind(traceId, after)
        .all<
          Omit<DiagnosticEventView, "attributes"> & { attributes: string }
        >();
      return {
        events: result.results.map((row) => ({
          ...row,
          attributes: v.parse(
            v.record(v.string(), v.unknown()),
            JSON.parse(row.attributes),
          ),
        })),
        nextCursor: result.results.at(-1)?.cursor ?? after,
      };
    },
    async artifacts(ownerId, traceId, after = 0) {
      if (!(await owned(ownerId, traceId))) return null;
      const artifacts = (
        await db
          .prepare(
            "SELECT ingest_seq AS cursor, id, span_id AS spanId, bytes, expires_at AS expiresAt FROM diagnostic_artifacts WHERE trace_id = ? AND ingest_seq > ? ORDER BY ingest_seq LIMIT 100",
          )
          .bind(traceId, after)
          .all<DiagnosticArtifactView>()
      ).results;
      return { artifacts, nextCursor: artifacts.at(-1)?.cursor ?? after };
    },
    async body(ownerId, artifactId) {
      const row = await db
        .prepare(`SELECT a.object_key AS objectKey, a.digest, a.expires_at AS expiresAt FROM diagnostic_artifacts a
        JOIN diagnostic_traces t ON t.id = a.trace_id WHERE a.id = ? AND (t.owner_id = ? OR t.owner_id IS NULL) AND t.expires_at > ?`)
        .bind(artifactId, ownerId, Date.now())
        .first<{ objectKey: string; digest: string; expiresAt: number }>();
      if (!row) return null;
      if (row.expiresAt <= Date.now())
        return new Response(null, { status: 410 });
      const object = await bucket?.get(row.objectKey);
      if (!object) return null;
      const content = await object.text();
      if ((await digestDiagnostic(content)) !== row.digest)
        throw new Error("Diagnostic artifact corrupt");
      return new Response(content, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  };
}

export async function expireDiagnostics(
  db: D1Database,
  bucket?: RunArtifactsBucket,
) {
  const now = Date.now();
  if (bucket?.delete) {
    const expired = await db
      .prepare(
        "SELECT id, object_key AS objectKey FROM diagnostic_artifacts WHERE expires_at <= ? AND deleted_at IS NULL LIMIT 50",
      )
      .bind(now)
      .all<{ id: string; objectKey: string }>();
    for (const row of expired.results) {
      await bucket.delete(row.objectKey);
      await db
        .prepare("UPDATE diagnostic_artifacts SET deleted_at = ? WHERE id = ?")
        .bind(now, row.id)
        .run();
    }
  }
  // Never cascade away the only pointer to a body before its deletion succeeds.
  await db
    .prepare(`DELETE FROM diagnostic_traces WHERE id IN (
    SELECT id FROM diagnostic_traces t WHERE expires_at <= ?
    AND NOT EXISTS (SELECT 1 FROM diagnostic_artifacts a WHERE a.trace_id = t.id AND a.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = t.run_id AND r.status IN ('queued', 'running')) LIMIT 50)`)
    .bind(now)
    .run();
}

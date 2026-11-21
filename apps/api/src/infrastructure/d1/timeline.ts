import type { D1Database } from "@cloudflare/workers-types";
import { sql } from "drizzle-orm";
import {
  DiagnosticBatch,
  diagnosticBodyRetentionMs,
  diagnosticRetentionMs,
  type DiagnosticRecord,
} from "@tailos/core/diagnostics";
import {
  timelinePageSize,
  TimelineItem,
  type TimelineChanges,
} from "@tailos/core/timeline";
import * as v from "valibot";
import {
  timelineObservation,
  type TimelineReader,
} from "@/application/sessions/timeline.ts";
import type { RunArtifactsBucket } from "@/infrastructure/r2/run-artifacts.ts";

export function timelineNotification(db: D1Database, runId: string) {
  return db
    .prepare(`INSERT INTO session_activity_notifications (session_id, version, delivered_version)
    SELECT session_id, (SELECT coalesce(max(cursor), 0) FROM session_activity_events WHERE session_id = runs.session_id), 0
    FROM runs WHERE id = ? ON CONFLICT(session_id) DO UPDATE SET version = max(version, excluded.version)`)
    .bind(runId);
}

export function timelineRecord(
  db: D1Database,
  runId: string,
  artifactId: string,
  record: DiagnosticRecord,
  now: number,
) {
  const observation = timelineObservation(record);
  if (!observation) return [];
  const id = `${runId}/${record.spanId}`;
  const finished = record.name === "span.finished";
  return [
    db
      .prepare(`INSERT INTO session_activity_events (event_id, session_id, run_id, item_id, kind, expires_at)
      SELECT ?, session_id, id, ?, 'item', ? FROM runs WHERE id = ?
      AND EXISTS (SELECT 1 FROM diagnostic_events WHERE event_id = ? AND trace_id = 'run/' || runs.id)
      ON CONFLICT(event_id) DO NOTHING`)
      .bind(
        record.eventId,
        id,
        now + diagnosticRetentionMs,
        runId,
        record.eventId,
      ),
    db
      .prepare(`INSERT INTO session_activity_items
      (id, session_id, run_id, kind, label, text, status, started_at, finished_at, duration_ms, exit_code, revision,
       first_cursor, input_artifact, input_event, output_artifact, output_event, body_expires_at, expires_at)
      SELECT ?, session_id, run_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, cursor, ?, ?, ?, ?, ?, ?
      FROM session_activity_events WHERE event_id = ?
      ON CONFLICT(id) DO UPDATE SET
        label = coalesce(session_activity_items.label, excluded.label),
        text = CASE WHEN excluded.revision >= revision THEN coalesce(excluded.text, text) ELSE text END,
        status = CASE WHEN excluded.finished_at IS NOT NULL AND excluded.revision >= revision THEN excluded.status ELSE status END,
        started_at = min(started_at, excluded.started_at),
        finished_at = coalesce(finished_at, excluded.finished_at),
        duration_ms = coalesce(duration_ms, excluded.duration_ms), exit_code = coalesce(exit_code, excluded.exit_code),
        revision = max(revision, excluded.revision), first_cursor = min(first_cursor, excluded.first_cursor),
        input_artifact = coalesce(input_artifact, excluded.input_artifact), input_event = coalesce(input_event, excluded.input_event),
        output_artifact = coalesce(output_artifact, excluded.output_artifact), output_event = coalesce(output_event, excluded.output_event),
        body_expires_at = min(body_expires_at, excluded.body_expires_at)`)
      .bind(
        id,
        observation.kind,
        observation.label,
        observation.text,
        observation.status,
        record.at,
        observation.finishedAt,
        observation.durationMs,
        observation.exitCode,
        record.seq,
        !finished && record.body !== undefined ? artifactId : null,
        !finished && record.body !== undefined ? record.eventId : null,
        finished && record.body !== undefined ? artifactId : null,
        finished && record.body !== undefined ? record.eventId : null,
        now + diagnosticBodyRetentionMs,
        now + diagnosticRetentionMs,
        record.eventId,
      ),
  ];
}

export function timelineMarker(
  db: D1Database,
  runId: string,
  eventId: string,
  kind: "session" | "capture",
  now: number,
  from?: string,
) {
  return db
    .prepare(`INSERT INTO session_activity_events (event_id, session_id, run_id, kind, expires_at)
    SELECT ?, session_id, id, ?, ? FROM runs WHERE id = ? AND (? IS NULL OR status = ?)
    ON CONFLICT(event_id) DO NOTHING`)
    .bind(
      eventId,
      kind,
      now + diagnosticRetentionMs,
      runId,
      from ?? null,
      from ?? null,
    );
}

const itemSelect = `i.id, i.run_id AS runId, i.kind,
  CASE WHEN i.kind = 'stage' OR i.body_expires_at > ? THEN i.label ELSE NULL END AS label,
  CASE WHEN i.body_expires_at > ? THEN i.text ELSE NULL END AS text,
  i.status, i.started_at AS startedAt, i.finished_at AS finishedAt, i.duration_ms AS durationMs,
  i.exit_code AS exitCode, i.revision, i.body_expires_at AS bodyExpiresAt,
  i.input_artifact IS NOT NULL AS hasInput, i.output_artifact IS NOT NULL AS hasOutput`;
const storedItem = v.object({
  ...TimelineItem.entries,
  hasInput: v.union([v.number(), v.boolean()]),
  hasOutput: v.union([v.number(), v.boolean()]),
});
function readItems(rows: unknown[]) {
  return rows.map((row) => {
    const item = v.parse(storedItem, row);
    return {
      ...item,
      hasInput: Boolean(item.hasInput),
      hasOutput: Boolean(item.hasOutput),
    };
  });
}

// Included in the Session reader's existing D1 batch: conversation, Run state,
// Items and replay position must all describe the same database snapshot.
export function timelineSnapshotFields(sessionId: string, now: number) {
  return {
    items: sql<string>`(SELECT json_group_array(json_object(
      'id', i.id, 'runId', i.run_id, 'kind', i.kind,
      'label', CASE WHEN i.kind = 'stage' OR i.body_expires_at > ${now} THEN i.label ELSE NULL END,
      'text', CASE WHEN i.body_expires_at > ${now} THEN i.text ELSE NULL END,
      'status', i.status, 'startedAt', i.started_at, 'finishedAt', i.finished_at,
      'durationMs', i.duration_ms, 'exitCode', i.exit_code, 'revision', i.revision,
      'bodyExpiresAt', i.body_expires_at, 'hasInput', i.input_artifact IS NOT NULL,
      'hasOutput', i.output_artifact IS NOT NULL, 'firstCursor', i.first_cursor))
      FROM (SELECT * FROM session_activity_items WHERE session_id = ${sessionId} AND expires_at > ${now}
      ORDER BY first_cursor DESC LIMIT ${timelinePageSize + 1}) i)`,
    cursor: sql<number>`(SELECT coalesce(max(cursor), 0) FROM session_activity_events WHERE session_id = ${sessionId} AND expires_at > ${now})`,
    captures: sql<string>`(SELECT json_group_array(json_object('runId', run_id, 'state', capture_state, 'dropped', dropped))
      FROM diagnostic_traces WHERE run_id IN (SELECT id FROM runs WHERE session_id = ${sessionId}) AND expires_at > ${now})`,
  };
}

export function readTimelineSnapshot(row: {
  items: string;
  cursor: number;
  captures: string;
}) {
  const rows = v.parse(
    v.array(v.object({ ...storedItem.entries, firstCursor: v.number() })),
    JSON.parse(row.items),
  );
  rows.sort((a, b) => b.firstCursor - a.firstCursor);
  const page = rows.slice(0, timelinePageSize);
  return {
    items: readItems(page).reverse(),
    cursor: row.cursor,
    before:
      rows.length > timelinePageSize
        ? (page.at(-1)?.firstCursor ?? null)
        : null,
    captures: v.parse(
      v.array(
        v.object({ runId: v.string(), state: v.string(), dropped: v.number() }),
      ),
      JSON.parse(row.captures),
    ),
  };
}

export function d1Timeline(
  db: D1Database,
  bucket?: RunArtifactsBucket,
): TimelineReader {
  return {
    async owned(sessionId, ownerId, projectId) {
      return Boolean(
        await db
          .prepare(
            `SELECT id FROM sessions WHERE id = ? AND owner_id = ? AND (? IS NULL OR project_id = ?)`,
          )
          .bind(sessionId, ownerId, projectId ?? null, projectId ?? null)
          .first(),
      );
    },
    async snapshot(sessionId, before) {
      const now = Date.now();
      const [rows, position, captures] = await db.batch([
        db
          .prepare(`SELECT ${itemSelect}, i.first_cursor AS firstCursor FROM session_activity_items i
          WHERE i.session_id = ? AND i.expires_at > ? AND (? IS NULL OR i.first_cursor < ?)
          ORDER BY i.first_cursor DESC LIMIT ?`)
          .bind(
            now,
            now,
            sessionId,
            now,
            before ?? null,
            before ?? null,
            timelinePageSize + 1,
          ),
        db
          .prepare(
            `SELECT coalesce(max(cursor), 0) AS cursor FROM session_activity_events WHERE session_id = ? AND expires_at > ?`,
          )
          .bind(sessionId, now),
        db
          .prepare(
            `SELECT run_id AS runId, capture_state AS state, dropped FROM diagnostic_traces WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?) AND expires_at > ?`,
          )
          .bind(sessionId, now),
      ]);
      const page = rows.results.slice(0, timelinePageSize);
      const positionRow = v.parse(
        v.object({ cursor: v.number() }),
        position.results[0],
      );
      return {
        items: readItems(page).reverse(),
        cursor: positionRow.cursor,
        before:
          rows.results.length > timelinePageSize
            ? v.parse(v.object({ firstCursor: v.number() }), page.at(-1))
                .firstCursor
            : null,
        captures: v.parse(
          v.array(
            v.object({
              runId: v.string(),
              state: v.string(),
              dropped: v.number(),
            }),
          ),
          captures.results,
        ),
      };
    },
    async changes(sessionId, after) {
      const now = Date.now();
      const [events, known] = await db.batch([
        db
          .prepare(`SELECT cursor, item_id AS itemId, kind FROM session_activity_events
          WHERE session_id = ? AND cursor > ? AND expires_at > ? ORDER BY cursor LIMIT ?`)
          .bind(sessionId, after, now, timelinePageSize + 1),
        db
          .prepare(
            `SELECT cursor FROM session_activity_events WHERE session_id = ? AND cursor = ? AND expires_at > ?`,
          )
          .bind(sessionId, after, now),
      ]);
      if (after > 0 && known.results.length === 0) return null;
      const page = v.parse(
        v.array(
          v.object({
            cursor: v.number(),
            itemId: v.nullable(v.string()),
            kind: v.string(),
          }),
        ),
        events.results.slice(0, timelinePageSize),
      );
      const ids = [
        ...new Set(
          page.flatMap((event) => (event.itemId ? [event.itemId] : [])),
        ),
      ];
      const rows: unknown[] = [];
      // Stay below D1's bound-parameter limit even for a full changes page.
      for (let offset = 0; offset < ids.length; offset += 80) {
        const chunk = ids.slice(offset, offset + 80);
        const result = await db
          .prepare(
            `SELECT ${itemSelect} FROM session_activity_items i WHERE i.session_id = ? AND i.id IN (${chunk.map(() => "?").join(",")}) AND i.expires_at > ?`,
          )
          .bind(now, now, sessionId, ...chunk, now)
          .all();
        rows.push(...result.results);
      }
      return {
        type: "changes",
        items: readItems(rows),
        cursor: page.at(-1)?.cursor ?? after,
        hasMore: events.results.length > timelinePageSize,
        sessionChanged: page.some((event) => event.kind === "session"),
        captureChanged: page.some((event) => event.kind === "capture"),
      } satisfies TimelineChanges;
    },
    async output(sessionId, itemId) {
      const now = Date.now();
      const row = await db
        .prepare(`SELECT input_artifact AS inputArtifact, input_event AS inputEvent, output_artifact AS outputArtifact,
        output_event AS outputEvent, body_expires_at AS bodyExpiresAt FROM session_activity_items WHERE session_id = ? AND id = ? AND expires_at > ?`)
        .bind(sessionId, itemId, now)
        .first<{
          inputArtifact: string | null;
          inputEvent: string | null;
          outputArtifact: string | null;
          outputEvent: string | null;
          bodyExpiresAt: number;
        }>();
      if (!row) return null;
      if (row.bodyExpiresAt <= now)
        return { input: null, output: null, expired: true };
      const cache = new Map<string, DiagnosticBatch>();
      async function body(artifactId: string | null, eventId: string | null) {
        if (!artifactId || !eventId) return null;
        if (!bucket) throw new Error("Timeline storage unavailable");
        let batch = cache.get(artifactId);
        if (!batch) {
          const artifact = await db
            .prepare(`SELECT a.object_key AS objectKey FROM diagnostic_artifacts a JOIN diagnostic_traces t ON t.id = a.trace_id
            WHERE a.id = ? AND t.session_id = ? AND a.expires_at > ?`)
            .bind(artifactId, sessionId, now)
            .first<{ objectKey: string }>();
          if (!artifact) return null;
          const object = await bucket.get(artifact.objectKey);
          if (!object) throw new Error("Timeline output unavailable");
          batch = v.parse(DiagnosticBatch, JSON.parse(await object.text()));
          cache.set(artifactId, batch);
        }
        return (
          batch.records.find((record) => record.eventId === eventId)?.body ??
          null
        );
      }
      const input = await body(row.inputArtifact, row.inputEvent);
      const output = await body(row.outputArtifact, row.outputEvent);
      return { input, output, expired: false };
    },
  };
}

export async function expireTimeline(db: D1Database) {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE session_activity_items SET label = CASE WHEN kind = 'stage' THEN label ELSE NULL END, text = NULL WHERE body_expires_at <= ? AND (kind != 'stage' AND label IS NOT NULL OR text IS NOT NULL)`,
      )
      .bind(now),
    db
      .prepare(`DELETE FROM session_activity_items WHERE expires_at <= ?`)
      .bind(now),
    db
      .prepare(`DELETE FROM session_activity_events WHERE expires_at <= ?`)
      .bind(now),
  ]);
}

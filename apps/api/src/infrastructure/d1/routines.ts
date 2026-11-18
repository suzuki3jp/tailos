import { diagnosticRetentionMs } from "@tailos/core/diagnostics";
import type { D1Database } from "@cloudflare/workers-types";
import * as v from "valibot";
import {
  routine,
  routineSettings,
  type Routine,
  type RoutineStore,
  type RoutineChange,
} from "@/application/routines/routines.ts";

type Row = {
  id: string;
  project_id: string;
  config: string;
  revision: number;
  deleted_at: number | null;
};
const parse = (row: Row): Routine =>
  v.parse(routine, {
    ...v.parse(routineSettings, JSON.parse(row.config)),
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    deletedAt: row.deleted_at,
  });
export function d1Routines(db: D1Database): RoutineStore {
  const owned = (ownerId: string, projectId: string, includeDeleted = false) =>
    db
      .prepare(
        "SELECT id FROM projects WHERE id = ? AND owner_id = ? AND (? OR deleted_at IS NULL)",
      )
      .bind(projectId, ownerId, includeDeleted ? 1 : 0)
      .first();
  return {
    async list(ownerId, projectId) {
      if (!(await owned(ownerId, projectId))) return null;
      const rows = await db
        .prepare(
          "SELECT * FROM routines WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at, id",
        )
        .bind(projectId)
        .all<Row>();
      return rows.results.map(parse);
    },
    async candidates(projectId) {
      const rows = await db
        .prepare(
          "SELECT r.* FROM routines r JOIN projects p ON p.id = r.project_id WHERE r.project_id = ? AND p.deleted_at IS NULL AND r.deleted_at IS NULL AND json_extract(r.config, '$.enabled') = 1 ORDER BY r.created_at, r.id",
        )
        .bind(projectId)
        .all<Row>();
      return rows.results.map(parse);
    },
    async save(ownerId, projectId, input, current) {
      const settings = v.parse(routineSettings, input);
      const now = Date.now();
      const id = current?.id ?? crypto.randomUUID();
      const config = JSON.stringify(settings);
      const row = current
        ? await db
            .prepare(`UPDATE routines SET config = ?, revision = revision + 1, updated_at = ?, updated_by = ?
          WHERE id = ? AND project_id = ? AND revision = ? AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM projects WHERE id = routines.project_id AND owner_id = ? AND deleted_at IS NULL) RETURNING *`)
            .bind(
              config,
              now,
              ownerId,
              id,
              projectId,
              current.revision,
              ownerId,
            )
            .first<Row>()
        : await db
            .prepare(`INSERT INTO routines (id, project_id, config, created_at, updated_at, updated_by)
          SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_id = ? AND deleted_at IS NULL) RETURNING *`)
            .bind(id, projectId, config, now, now, ownerId, projectId, ownerId)
            .first<Row>();
      return row ? parse(row) : null;
    },
    async remove(ownerId, projectId, id, revision) {
      const row = await db
        .prepare(`UPDATE routines SET deleted_at = ?, updated_at = ?, updated_by = ?, revision = revision + 1
        WHERE id = ? AND project_id = ? AND revision = ? AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM projects WHERE id = routines.project_id AND owner_id = ? AND deleted_at IS NULL) RETURNING id`)
        .bind(Date.now(), Date.now(), ownerId, id, projectId, revision, ownerId)
        .first();
      return row !== null;
    },
    async history(ownerId, projectId, before) {
      if (!(await owned(ownerId, projectId, true))) return null;
      const rows = await db
        .prepare(
          `SELECT c.* FROM routine_changes c JOIN routines r ON r.id = c.routine_id WHERE r.project_id = ? AND c.id < ? ORDER BY c.id DESC LIMIT 51`,
        )
        .bind(projectId, before ?? Number.MAX_SAFE_INTEGER)
        .all<{
          id: number;
          routine_id: string;
          actor_id: string;
          created_at: number;
          before_config: string | null;
          after_config: string | null;
        }>();
      const changes: RoutineChange[] = rows.results.slice(0, 50).map((row) => ({
        id: row.id,
        routineId: row.routine_id,
        actorId: row.actor_id,
        createdAt: row.created_at,
        before: row.before_config
          ? v.parse(routineSettings, JSON.parse(row.before_config))
          : null,
        after: row.after_config
          ? v.parse(routineSettings, JSON.parse(row.after_config))
          : null,
      }));
      return {
        changes,
        nextCursor: rows.results.length > 50 ? changes.at(-1)!.id : null,
      };
    },
  };
}

export async function replayLabelDelivery(
  db: D1Database,
  deliveryId: string,
  ownerId: string,
  diagnostics?: { traceId: string; requestId: string },
) {
  const rows = await db
    .prepare(`SELECT e.routine_id AS routineId, e.run_id AS runId, r.session_id AS sessionId, e.disposition
    FROM trigger_events e JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id
    WHERE e.source = 'github.issue-label' AND e.delivery_id = ? AND s.owner_id = ? AND e.routine_id IS NOT NULL`)
    .bind(deliveryId, ownerId)
    .all<import("@/application/routines/dispatch-label.ts").LabelResult>();
  if (diagnostics && rows.results.length) {
    const now = Date.now();
    const { traceId, requestId } = diagnostics;
    await db
      .batch([
        db
          .prepare(`INSERT INTO diagnostic_traces (id, owner_id, session_id, source, delivery_id, request_id, created_at, expires_at)
        VALUES (?, ?, ?, 'github.issue-label', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
          .bind(
            traceId,
            ownerId,
            rows.results[0].sessionId,
            deliveryId,
            requestId,
            now,
            now + diagnosticRetentionMs,
          ),
        ...rows.results.flatMap((row) => [
          db
            .prepare(`INSERT INTO diagnostic_links (from_trace, to_trace, relation)
          VALUES (?, ?, 'replays') ON CONFLICT DO NOTHING`)
            .bind(traceId, `run/${row.runId}`),
          db
            .prepare(`INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, request_id, occurred_at, received_at, name, attributes)
          VALUES (?, ?, ?, 'api', ?, ?, ?, 'trigger.decided', ?)`)
            .bind(
              crypto.randomUUID(),
              traceId,
              traceId,
              requestId,
              now,
              now,
              JSON.stringify({ outcome: "replayed", routineId: row.routineId }),
            ),
        ]),
      ])
      .catch(() => {
        // oxlint-disable-next-line no-console -- IDs only; diagnostics do not change a committed replay result.
        console.warn("Replay diagnostic write failed", { traceId, requestId });
      });
  }
  return rows.results;
}

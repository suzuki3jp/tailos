import type { D1Database } from "@cloudflare/workers-types";

export function findOwnedRun(db: D1Database, id: string, ownerId: string) {
  return db
    .prepare(
      `SELECT runs.id, runs.status, runs.error_code AS errorCode FROM runs JOIN sessions ON sessions.id = runs.session_id
     WHERE runs.id = ? AND sessions.owner_id = ?`,
    )
    .bind(id, ownerId)
    .first<{ id: string; status: string; errorCode: string | null }>();
}

import type { D1Database } from "@cloudflare/workers-types";
import type {
  IssueNotification,
  NotificationStore,
} from "@/application/notifications/issue-comment.ts";

export function issueNotificationStore(db: D1Database): NotificationStore {
  return {
    async claim() {
      const now = Date.now();
      const lease = crypto.randomUUID();
      const result = await db
        .prepare(`UPDATE issue_notifications SET lease = ?, lease_until = ?, attempts = attempts + 1
        WHERE rowid IN (SELECT rowid FROM issue_notifications
          WHERE next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
            AND applied_version < version ORDER BY next_attempt_at LIMIT 1)
        RETURNING *,
          (SELECT session_id FROM runs WHERE runs.id = issue_notifications.run_id) AS session_id,
          (SELECT s.project_id FROM runs r JOIN sessions s ON s.id = r.session_id
            WHERE r.id = issue_notifications.run_id) AS project_id,
          (SELECT json_extract(execution_context, '$.repository') FROM runs
            WHERE runs.id = issue_notifications.run_id) AS target,
          (SELECT json_extract(execution_context, '$.trigger') FROM runs
            WHERE runs.id = issue_notifications.run_id) AS trigger`)
        .bind(lease, now + 300_000, now, now)
        .all<IssueNotification>();
      return result.results;
    },
    async complete(n, id) {
      await db
        .prepare(`UPDATE issue_notifications SET comment_id = ?, applied_version = ?,
        lease = NULL, lease_until = NULL, error_category = NULL,
        next_attempt_at = CASE WHEN version > ? THEN 0 ELSE NULL END
        WHERE run_id = ? AND lease = ?`)
        .bind(id, n.version, n.version, n.run_id, n.lease)
        .run();
    },
    async fail(n, category, retryAt) {
      await db
        .prepare(`UPDATE issue_notifications SET error_category = ?, next_attempt_at = ?, lease = NULL, lease_until = NULL
        WHERE run_id = ? AND lease = ?`)
        .bind(category, retryAt, n.run_id, n.lease)
        .run();
    },
  };
}

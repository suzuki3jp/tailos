import type { D1Database } from "@cloudflare/workers-types";
import type {
  IssueNotification,
  NotificationStore,
} from "@/application/notifications/issue-comment.ts";

export function planningReplyStore(db: D1Database): NotificationStore {
  return {
    async claim() {
      const now = Date.now();
      const lease = crypto.randomUUID();
      const result = await db
        .prepare(`UPDATE planning_replies SET lease = ?, lease_until = ?, attempts = attempts + 1
        WHERE input_id IN (SELECT n.input_id FROM planning_replies n JOIN planning_inbox i ON i.id = n.input_id
          WHERE n.state = 'pending' AND n.next_attempt_at <= ? AND (n.lease_until IS NULL OR n.lease_until <= ?)
          AND NOT EXISTS (SELECT 1 FROM planning_inbox earlier LEFT JOIN planning_replies reply ON reply.input_id = earlier.id
            WHERE earlier.scope = i.scope AND earlier.id < i.id AND (reply.state IS NULL OR reply.state = 'pending'))
          ORDER BY n.input_id LIMIT 1)
        RETURNING *, body AS reply_body,
          coalesce((SELECT run_id FROM planning_inbox WHERE id = input_id), 'guidance') AS run_id,
          (SELECT session_id FROM planning_issues WHERE scope = (SELECT scope FROM planning_inbox WHERE id = input_id)) AS session_id,
          (SELECT s.project_id FROM planning_inbox i JOIN planning_issues p ON p.scope = i.scope
            JOIN sessions s ON s.id = p.session_id WHERE i.id = input_id) AS project_id,
          (SELECT json_extract(execution_context, '$.repository') FROM planning_inbox WHERE id = input_id) AS target,
          (SELECT json_extract(execution_context, '$.trigger') FROM planning_inbox WHERE id = input_id) AS trigger,
          'succeeded' AS desired_state, 1 AS version`)
        .bind(lease, now + 300_000, now, now)
        .all<IssueNotification>();
      return result.results;
    },
    async complete(n, id) {
      await db
        .prepare(`UPDATE planning_replies SET state = 'sent', comment_id = ?, lease = NULL, lease_until = NULL,
        error_category = NULL, next_attempt_at = NULL WHERE input_id = ? AND lease = ?`)
        .bind(id, n.input_id, n.lease)
        .run();
    },
    async fail(n, category, retryAt) {
      await db
        .prepare(`UPDATE planning_replies SET state = ?, error_category = ?, next_attempt_at = ?, lease = NULL, lease_until = NULL
        WHERE input_id = ? AND lease = ?`)
        .bind(
          retryAt === null ? "failed" : "pending",
          category,
          retryAt,
          n.input_id,
          n.lease,
        )
        .run();
    },
  };
}

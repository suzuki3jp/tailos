import type { D1Database } from "@cloudflare/workers-types";
import type {
  IssueNotification,
  NotificationStore,
} from "@/application/notifications/issue-comment.ts";
import type { IssueGuidance } from "@/application/routines/dispatch-issue.ts";

/** Keeps a guidance reply until it is sent; one per comment. */
export async function queueIssueGuidance(
  db: D1Database,
  guidance: IssueGuidance,
) {
  await db
    .prepare(`INSERT INTO issue_guidance (id, target, trigger, body, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(
      guidance.id,
      JSON.stringify(guidance.target),
      JSON.stringify(guidance.trigger),
      guidance.body,
      0,
      Date.now(),
    )
    .run();
}

export function issueGuidanceStore(db: D1Database): NotificationStore {
  return {
    async claim() {
      const now = Date.now();
      const lease = crypto.randomUUID();
      const result = await db
        .prepare(`UPDATE issue_guidance SET lease = ?, lease_until = ?, attempts = attempts + 1
        WHERE id IN (SELECT id FROM issue_guidance WHERE state = 'pending' AND next_attempt_at <= ?
          AND (lease_until IS NULL OR lease_until <= ?) ORDER BY next_attempt_at LIMIT 1)
        RETURNING *, id AS guidance_id, body AS reply_body, 'guidance/' || id AS run_id,
          NULL AS session_id, 'succeeded' AS desired_state, 1 AS version`)
        .bind(lease, now + 300_000, now, now)
        .all<IssueNotification>();
      return result.results;
    },
    async complete(n, id) {
      await db
        .prepare(`UPDATE issue_guidance SET state = 'sent', comment_id = ?, lease = NULL, lease_until = NULL,
        error_category = NULL, next_attempt_at = NULL WHERE id = ? AND lease = ?`)
        .bind(id, n.guidance_id, n.lease)
        .run();
    },
    async fail(n, category, retryAt) {
      await db
        .prepare(`UPDATE issue_guidance SET state = ?, error_category = ?, next_attempt_at = ?, lease = NULL, lease_until = NULL
        WHERE id = ? AND lease = ?`)
        .bind(
          retryAt === null ? "failed" : "pending",
          category,
          retryAt,
          n.guidance_id,
          n.lease,
        )
        .run();
    },
  };
}

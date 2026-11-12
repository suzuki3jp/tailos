import type { RepositoryTarget } from "@tailos/core/runner";

export type NotificationState = "processing" | "succeeded" | "failed";
export type IssueNotification = {
  run_id: string;
  session_id: string;
  target: string;
  comment_id: number | null;
  desired_state: NotificationState;
  version: number;
  attempts: number;
  lease: string;
};
export class NotificationError extends Error {
  constructor(
    public category: "permission" | "rate_limit" | "transient",
    public retryAt?: number,
  ) {
    super(category);
  }
}
export function commentBody(
  origin: string,
  n: Pick<IssueNotification, "run_id" | "session_id" | "desired_state">,
) {
  const state = n.desired_state;
  const alt =
    state === "processing" ? "処理中" : state === "succeeded" ? "完了" : "失敗";
  const asset =
    state === "processing" ? "tailos-rolling-v1.gif" : `tailos-${state}-v1.png`;
  return `![Tailos が${alt}](${new URL(`/assets/${asset}`, origin)})\n\n[セッションを開く ↗](${new URL(`/sessions/${encodeURIComponent(n.session_id)}`, origin)})\n\n<!-- tailos:run:${n.run_id}:v1 -->`;
}
export type NotificationStore = {
  claim(): Promise<IssueNotification[]>;
  complete(n: IssueNotification, commentId: number): Promise<void>;
  fail(
    n: IssueNotification,
    category: string,
    retryAt: number | null,
  ): Promise<void>;
};
export async function sendIssueNotifications(
  store: NotificationStore,
  origin: string,
  publish: (
    target: RepositoryTarget,
    marker: string,
    body: string,
    commentId: number | null,
  ) => Promise<number>,
) {
  // Claim immediately before each delivery so a slow GitHub request cannot
  // consume the leases of other notifications in this sweep.
  for (let attempt = 0; attempt < 10; attempt++) {
    const [n] = await store.claim();
    if (!n) break;
    try {
      const id = await publish(
        JSON.parse(n.target),
        `<!-- tailos:run:${n.run_id}:v1 -->`,
        commentBody(origin, n),
        n.comment_id,
      );
      await store.complete(n, id);
      // oxlint-disable-next-line no-console -- notification IDs and allowlisted state only
      console.info("Issue notification", {
        runId: n.run_id,
        state: n.desired_state,
        attempt: n.attempts,
        outcome: "applied",
      });
    } catch (error) {
      const category =
        error instanceof NotificationError ? error.category : "transient";
      const retryAt =
        category === "permission"
          ? null
          : error instanceof NotificationError && error.retryAt
            ? error.retryAt
            : Date.now() +
              Math.min(3_600_000, 1000 * 2 ** Math.min(n.attempts, 12));
      await store.fail(n, category, retryAt);
      // oxlint-disable-next-line no-console -- never include provider errors or credentials
      console.warn("Issue notification", {
        runId: n.run_id,
        state: n.desired_state,
        attempt: n.attempts,
        outcome: "failed",
        category,
      });
    }
  }
}

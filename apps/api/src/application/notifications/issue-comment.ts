import type { RepositoryTarget } from "@tailos/core/runner";

export type NotificationState = "processing" | "succeeded" | "failed";
export type IssueNotification = {
  run_id: string;
  input_id?: number;
  reply_body?: string;
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
    public category: "permission" | "permanent" | "rate_limit" | "transient",
    public retryAt?: number,
  ) {
    super(category);
  }
}
export function notificationMarker(
  n: Pick<IssueNotification, "run_id" | "input_id">,
) {
  return n.input_id === undefined
    ? `<!-- tailos:run:${n.run_id}:v1 -->`
    : `<!-- tailos:plan:${n.run_id}:input:${n.input_id}:reply:v1 -->`;
}

export function commentBody(
  origin: string,
  n: Pick<
    IssueNotification,
    "run_id" | "session_id" | "desired_state" | "input_id" | "reply_body"
  >,
) {
  if (n.reply_body !== undefined) {
    // Escape all mentions, including team mentions and copied command examples.
    const text = n.reply_body
      .replaceAll("@", "@\u200b")
      .replaceAll("<!-- tailos:", "&lt;!-- tailos:");
    return `${text}\n\n[セッションを開く ↗](${new URL(`/sessions/${encodeURIComponent(n.session_id)}`, origin)})\n\n${notificationMarker(n)}`;
  }
  const state = n.desired_state;
  const alt = { processing: "処理中", succeeded: "完了", failed: "失敗" }[
    state
  ];
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
        notificationMarker(n),
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
      const failure =
        error instanceof NotificationError ? error.category : "transient";
      const category =
        failure === "transient" && n.attempts >= 20 ? "permanent" : failure;
      let retryAt = null;
      if (category !== "permission" && category !== "permanent") {
        const explicitRetryAt =
          error instanceof NotificationError ? error.retryAt : undefined;
        retryAt =
          explicitRetryAt ||
          Date.now() +
            Math.min(
              3_600_000,
              (category === "rate_limit" ? 60_000 : 1000) *
                2 ** Math.min(n.attempts, 12),
            );
      }
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

import type { RepositoryTarget } from "@tailos/core/runner";

export type IssueTarget = RepositoryTarget & { issueNumber: number };

export type NotificationState = "processing" | "succeeded" | "failed";
const notificationLabels = {
  processing: "処理中",
  succeeded: "完了",
  failed: "失敗",
} satisfies Record<NotificationState, string>;

export type IssueNotification = {
  run_id: string;
  input_id?: number;
  reply_body?: string;
  session_id: string;
  project_id: string | null;
  target: string;
  /** Absent for contexts stored before triggers, which kept the issue in target. */
  trigger?: string | null;
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
    | "run_id"
    | "session_id"
    | "project_id"
    | "desired_state"
    | "input_id"
    | "reply_body"
  >,
) {
  const sessionPath = `/sessions/${encodeURIComponent(n.session_id)}`;
  const projectPath =
    n.project_id === null ? "" : `/${encodeURIComponent(n.project_id)}`;
  const sessionUrl = new URL(projectPath + sessionPath, origin);
  if (n.reply_body !== undefined) {
    // Escape all mentions, including team mentions and copied command examples.
    const text = n.reply_body
      .replaceAll("@", "@\u200b")
      .replaceAll("<!-- tailos:", "&lt;!-- tailos:");
    return `${text}\n\n[セッションを開く ↗](${sessionUrl})\n\n${notificationMarker(n)}`;
  }
  const state = n.desired_state;
  const alt = notificationLabels[state];
  const asset =
    state === "processing" ? "tailos-rolling-v1.gif" : `tailos-${state}-v1.png`;
  return `![Tailos が${alt}](${new URL(`/assets/${asset}`, origin)})\n\n[セッションを開く ↗](${sessionUrl})\n\n<!-- tailos:run:${n.run_id}:v1 -->`;
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

function notificationRetryAt(
  category: NotificationError["category"],
  error: unknown,
  attempts: number,
): number | null {
  if (category === "permission" || category === "permanent") return null;
  if (error instanceof NotificationError && error.retryAt) return error.retryAt;
  const initialDelay = category === "rate_limit" ? 60_000 : 1000;
  return (
    Date.now() + Math.min(3_600_000, initialDelay * 2 ** Math.min(attempts, 12))
  );
}

function notificationTarget(n: IssueNotification): IssueTarget {
  const target = JSON.parse(n.target) as IssueTarget;
  const trigger: unknown = n.trigger ? JSON.parse(n.trigger) : null;
  if (
    typeof trigger === "object" &&
    trigger !== null &&
    "issueNumber" in trigger &&
    typeof trigger.issueNumber === "number"
  )
    return { ...target, issueNumber: trigger.issueNumber };
  if (typeof target.issueNumber !== "number")
    throw new NotificationError("permanent");
  return target;
}

export async function sendIssueNotifications(
  store: NotificationStore,
  origin: string,
  publish: (
    target: IssueTarget,
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
        notificationTarget(n),
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
      const retryAt = notificationRetryAt(category, error, n.attempts);
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

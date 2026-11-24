import { expect, test } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { issueNotificationStore } from "@/infrastructure/d1/issue-notifications.ts";
import {
  commentBody,
  NotificationError,
  sendIssueNotifications,
} from "@/application/notifications/issue-comment.ts";

const target = {
  repository: "owner/repo",
  repositoryId: 1,
  installationId: 2,
  issueNumber: 3,
  defaultBranch: "main",
  triggerLabel: "tailos:run",
};
const input = {
  source: "github.issue-label",
  idempotencyKey: "one",
  ownerId: "owner",
  concurrencyKey: "issue",
  prompt: "implement",
  executionContext: JSON.stringify({ repository: target }),
  timeoutMs: 1000,
};

test("durable deduplication, exclusive lease, terminal race and separate reruns", async (t) => {
  const db = await createTestDb(t);
  const run = await admitTrigger(db, input);
  await admitTrigger(db, input);
  await admitTrigger(db, { ...input, idempotencyKey: "two" });
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM issue_notifications")
      .first("n"),
  ).toBe(1);
  const store = issueNotificationStore(db);
  const [n] = await store.claim();
  expect(n).toBeDefined();
  expect(await store.claim()).toEqual([]);
  await db
    .prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?")
    .bind(run.runId)
    .run();
  await store.complete(n!, 42);
  const [finished] = await store.claim();
  expect(finished?.desired_state).toBe("succeeded");
  expect(finished?.comment_id).toBe(42);
  await store.complete(finished!, 42);
  expect(await store.claim()).toEqual([]);
  const next = await admitTrigger(db, { ...input, idempotencyKey: "three" });
  expect(next.runId).not.toBe(run.runId);
  await db
    .prepare("UPDATE runs SET status = 'failed' WHERE id = ?")
    .bind(next.runId)
    .run();
  await db
    .prepare("UPDATE sessions SET project_id = ? WHERE id = ?")
    .bind("project/id", next.sessionId)
    .run();
  await sendIssueNotifications(
    store,
    "https://tailos.app",
    async (actualTarget, _marker, body, id) => {
      expect(actualTarget).toEqual(target);
      expect(body).toContain("tailos-failed-v1.png");
      expect(body).toContain(
        `https://tailos.app/project%2Fid/sessions/${next.sessionId})`,
      );
      expect(id).toBeNull();
      return 43;
    },
  );
  expect(await store.claim()).toEqual([]);
});

test("rate limits without a retry header back off for at least one minute", async (t) => {
  const db = await createTestDb(t);
  const run = await admitTrigger(db, input);
  const store = issueNotificationStore(db);
  const before = Date.now();
  await sendIssueNotifications(store, "https://tailos.app", async () => {
    throw new NotificationError("rate_limit");
  });
  const retryAt = await db
    .prepare("SELECT next_attempt_at FROM issue_notifications")
    .first<number>("next_attempt_at");
  expect(retryAt).toBeGreaterThanOrEqual(before + 60_000);
  await db
    .prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?")
    .bind(run.runId)
    .run();
  expect(await store.claim()).toEqual([]);
  await db.prepare("UPDATE issue_notifications SET next_attempt_at = 0").run();
  await sendIssueNotifications(
    store,
    "https://tailos.app",
    async (_t, _m, body) => {
      expect(body).toContain("tailos-succeeded-v1.png");
      return 42;
    },
  );
  expect(await store.claim()).toEqual([]);
});

test("lease expiry recovers and permission failures stop retrying", async (t) => {
  const db = await createTestDb(t);
  await admitTrigger(db, input);
  const store = issueNotificationStore(db);
  const [stale] = await store.claim();
  await db.prepare("UPDATE issue_notifications SET lease_until = 0").run();
  await sendIssueNotifications(store, "https://tailos.app", async () => {
    throw new NotificationError("permission");
  });
  await store.complete(stale!, 99);
  expect(await store.claim()).toEqual([]);
  expect(
    await db
      .prepare("SELECT error_category FROM issue_notifications")
      .first("error_category"),
  ).toBe("permission");
  expect(
    await db
      .prepare("SELECT comment_id FROM issue_notifications")
      .first("comment_id"),
  ).toBeNull();
});

test.for(["permanent", "transient"] as const)(
  "stops %s failures without reviving retries when the run finishes",
  async (category, t) => {
    const db = await createTestDb(t);
    const run = await admitTrigger(db, input);
    const store = issueNotificationStore(db);
    // A transient failure gets one more attempt before reaching the limit.
    await db.prepare("UPDATE issue_notifications SET attempts = 18").run();
    let calls = 0;
    const publish = async () => {
      calls++;
      throw new NotificationError(category);
    };
    await sendIssueNotifications(store, "https://tailos.app", publish);
    if (category === "transient") {
      expect(
        await db
          .prepare("SELECT error_category FROM issue_notifications")
          .first("error_category"),
      ).toBe("transient");
      await db
        .prepare("UPDATE issue_notifications SET next_attempt_at = 0")
        .run();
      await sendIssueNotifications(store, "https://tailos.app", publish);
    }
    expect(
      await db
        .prepare(
          "SELECT error_category, next_attempt_at FROM issue_notifications",
        )
        .first(),
    ).toEqual({ error_category: "permanent", next_attempt_at: null });
    await db
      .prepare("UPDATE runs SET status = 'failed' WHERE id = ?")
      .bind(run.runId)
      .run();
    expect(await store.claim()).toEqual([]);
    expect(calls).toBe(category === "transient" ? 2 : 1);
  },
);

test("comment renders only image and session link plus hidden marker", () => {
  expect(
    commentBody("https://tailos.app", {
      run_id: "run",
      session_id: "session",
      project_id: null,
      desired_state: "processing",
    }),
  ).toBe(
    "![Tailos が処理中](https://tailos.app/assets/tailos-rolling-v1.gif)\n\n[セッションを開く ↗](https://tailos.app/sessions/session)\n\n<!-- tailos:run:run:v1 -->",
  );
});

test("a guidance reply has no Session link and its own marker", () => {
  expect(
    commentBody("https://tailos.app", {
      run_id: "guidance/42/100",
      guidance_id: "42/100",
      session_id: null,
      project_id: null,
      desired_state: "succeeded",
      reply_body: "Send @tailos plan",
    }),
  ).toBe("Send @\u200btailos plan\n\n<!-- tailos:guidance:42/100:v1 -->");
});

test("rate limits persist their retry deadline independently of run recovery", async (t) => {
  const db = await createTestDb(t);
  const run = await admitTrigger(db, input);
  const store = issueNotificationStore(db);
  const retryAt = Date.now() + 120_000;
  await sendIssueNotifications(store, "https://tailos.app", async () => {
    throw new NotificationError("rate_limit", retryAt);
  });
  expect(
    await db
      .prepare("SELECT next_attempt_at FROM issue_notifications")
      .first("next_attempt_at"),
  ).toBe(retryAt);
  expect(await store.claim()).toEqual([]);
  await db
    .prepare("UPDATE runs SET status = 'failed' WHERE id = ?")
    .bind(run.runId)
    .run();
  expect(await store.claim()).toEqual([]);
  await db.prepare("UPDATE issue_notifications SET next_attempt_at = 0").run();
  const [n] = await store.claim();
  expect(n?.desired_state).toBe("failed");
});

test("notification insertion rolls back the run and session on failure", async (t) => {
  const db = await createTestDb(t);
  await db
    .prepare(
      "CREATE TRIGGER reject_notification BEFORE INSERT ON issue_notifications BEGIN SELECT RAISE(ABORT, 'notification failure'); END",
    )
    .run();
  await expect(admitTrigger(db, input)).rejects.toThrow("notification failure");
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(0);
  expect(
    await db.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(0);
});

import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import {
  createTestBindings,
  createTestDb,
} from "@/infrastructure/d1/testing.ts";
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

test("upgrades existing notifications while preserving delivery and terminal recovery", async (t) => {
  const { DB: db } = await createTestBindings(t, {
    migrationsThrough: "0006_crazy_solo.sql",
  });
  // Seed an admission made by the previous Worker before its migration.
  await db.batch([
    db.prepare(
      "INSERT INTO sessions (id, owner_id, created_at) VALUES ('session', 'owner', 0)",
    ),
    db.prepare(
      "INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at) VALUES ('message', 'session', 1, 'automation', 'implement', 0)",
    ),
    db
      .prepare(
        "INSERT INTO runs (id, session_id, start_message_id, status, execution_context, deadline_at, created_at) VALUES ('run', 'session', 'message', 'running', ?, 1000, 0)",
      )
      .bind(input.executionContext),
    db
      .prepare(`INSERT INTO issue_notifications
      (run_id, session_id, target, comment_id, applied_state, applied_version, attempts,
        error_category, next_attempt_at, lease, lease_until)
      VALUES ('run', 'session', ?, 42, 'processing', 1, 3, 'rate_limit', ?, 'inflight', ?)`)
      .bind(JSON.stringify(target), Date.now() + 120_000, Date.now() + 300_000),
  ]);
  const migration = await readFile(
    new URL("../../../migrations/0007_gray_jackal.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    migration.split("--> statement-breakpoint").map((s) => db.prepare(s)),
  );
  expect(
    await db.prepare("SELECT * FROM issue_notifications").first(),
  ).toMatchObject({
    run_id: "run",
    comment_id: 42,
    applied_version: 1,
    attempts: 3,
    error_category: "rate_limit",
    lease: "inflight",
  });
  await db
    .prepare("UPDATE runs SET status = 'succeeded' WHERE id = 'run'")
    .run();
  const store = issueNotificationStore(db);
  expect(await store.claim()).toEqual([]);
  await db
    .prepare(
      "UPDATE issue_notifications SET next_attempt_at = 0, lease_until = 0",
    )
    .run();
  const [n] = await store.claim();
  expect(n).toMatchObject({
    comment_id: 42,
    desired_state: "succeeded",
    version: 2,
    session_id: "session",
  });
  expect(JSON.parse(n!.target)).toEqual(target);
  await store.complete(n!, 42);
  expect(await store.claim()).toEqual([]);
});

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
  await sendIssueNotifications(
    store,
    "https://tailos.app",
    async (actualTarget, _marker, body, id) => {
      expect(actualTarget).toEqual(target);
      expect(body).toContain("tailos-failed-v1.png");
      expect(body).toContain(`/sessions/${next.sessionId}`);
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
      desired_state: "processing",
    }),
  ).toBe(
    "![Tailos が処理中](https://tailos.app/assets/tailos-rolling-v1.gif)\n\n[セッションを開く ↗](https://tailos.app/sessions/session)\n\n<!-- tailos:run:run:v1 -->",
  );
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

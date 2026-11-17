import { expect, test, type TestContext } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import {
  acceptPlanningInput,
  dispatchPlanningInputs,
  savePlanningSnapshot,
} from "@/infrastructure/d1/planning.ts";
import { advanceRun } from "@/infrastructure/d1/run-execution.ts";
import { planningReplyStore } from "@/infrastructure/d1/planning-replies.ts";
import {
  commentBody,
  NotificationError,
  sendIssueNotifications,
} from "@/application/notifications/issue-comment.ts";
import { listDueRunIds } from "@/infrastructure/d1/run-recovery.ts";

const target = {
  repository: "owner/repo",
  repositoryId: 1,
  installationId: 2,
  issueNumber: 3,
  defaultBranch: "main",
  triggerLabel: "tailos:run",
};
const input = {
  ownerId: "operator",
  projectId: "00000000-0000-4000-8000-000000000001",
  repositoryId: 1,
  issueNumber: 3,
  commentId: 100,
  actor: "allowed",
  url: "https://github.com/owner/repo/issues/3#issuecomment-100",
  body: "@tailos plan",
  deliveryId: "delivery-100",
  start: true,
  executionContext: JSON.stringify({
    version: 1,
    engine: "codex",
    mode: "plan",
    connectionId: `codex/${crypto.randomUUID()}`,
    repository: target,
  }),
  timeoutMs: 60_000,
};

async function planningDb(t: TestContext) {
  const db = await createTestDb(t);
  for (const [id, repositoryId] of [
    [input.projectId, 1],
    ["00000000-0000-4000-8000-000000000002", 4],
  ] as const) {
    const config = {
      id,
      repository: "owner/repo",
      repositoryId,
      installationId: 2,
      triggerLabel: "tailos:run",
      allowedActors: ["allowed"],
      agentNetworkAccess: false,
      maxRunMinutes: 1,
    };
    await db
      .prepare(
        "INSERT INTO projects (id, owner_id, name, repository_id, config, created_at, updated_at, updated_by) VALUES (?, 'operator', 'Planning', ?, ?, 1, 1, 'operator')",
      )
      .bind(id, repositoryId, JSON.stringify(config))
      .run();
  }
  return db;
}

test("deduplicates concurrent first comments and deliveries, then drains inputs once in persistence order", async (t) => {
  const db = await planningDb(t);
  const receipts = await Promise.all([
    acceptPlanningInput(db, input),
    acceptPlanningInput(db, input),
    acceptPlanningInput(db, { ...input, deliveryId: "replay" }),
  ]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect(receipts[0]).toEqual(receipts[2]);
  expect(
    await db.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(1);
  const jobs = (
    await Promise.all([dispatchPlanningInputs(db), dispatchPlanningInputs(db)])
  ).flat();
  expect(jobs).toHaveLength(1);
  expect(await listDueRunIds(db, Date.now())).toEqual(jobs); // crash before scheduling
  const runId = jobs[0]!;
  await acceptPlanningInput(db, {
    ...input,
    commentId: 99,
    deliveryId: "late-old-comment",
    body: "@tailos use option B",
    start: false,
  });
  await acceptPlanningInput(db, {
    ...input,
    commentId: 101,
    deliveryId: "another-plan",
  });
  expect(await dispatchPlanningInputs(db)).toEqual([]);
  const snapshot = await savePlanningSnapshot(
    db,
    runId,
    { title: "Original", body: "Issue body" },
    "a".repeat(40),
  );
  expect(JSON.parse(snapshot!.context).conversation).toHaveLength(1);
  expect(
    await savePlanningSnapshot(
      db,
      runId,
      { title: "Edited", body: "Changed" },
      "b".repeat(40),
    ),
  ).toEqual(snapshot);
  await advanceRun(db, runId, {
    start: async () => ({
      status: "succeeded",
      reply: "Which option?",
      plan: { planPresented: false, needsAnswer: true },
      events: [],
    }),
    poll: async () => {
      throw new Error("unexpected poll");
    },
  });
  const second = (await dispatchPlanningInputs(db))[0]!; // crash after completion, recovered by Cron
  expect(second).toBeTruthy();
  const nextSnapshot = await savePlanningSnapshot(
    db,
    second,
    { title: "Edited", body: "Latest" },
    "b".repeat(40),
  );
  const conversation = JSON.parse(nextSnapshot!.context).conversation;
  expect(conversation.map((m: { body: string }) => m.body)).toEqual([
    "@tailos plan",
    "@tailos use option B",
  ]);
  expect(conversation[0].reply).toBe("Which option?");
  await advanceRun(db, second, {
    start: async () => ({
      status: "succeeded",
      reply: "Plan for B @everyone",
      plan: { planPresented: true, needsAnswer: false },
      events: [],
    }),
    poll: async () => {
      throw new Error("unexpected");
    },
  });
  const third = (await dispatchPlanningInputs(db))[0]!;
  await advanceRun(db, third, {
    start: async () => ({
      status: "failed",
      errorCode: "agent_failed",
      events: [],
    }),
    poll: async () => {
      throw new Error("unexpected");
    },
  });
  expect(await dispatchPlanningInputs(db)).toEqual([]);
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(3);
  expect(
    await db.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT latest_run_id, latest_plan_run_id FROM planning_issues")
      .first(),
  ).toEqual({ latest_run_id: third, latest_plan_run_id: second });
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM issue_notifications")
      .first("n"),
  ).toBe(3);
  const store = planningReplyStore(db);
  const [firstReply] = await store.claim();
  expect(firstReply?.run_id).toBe(runId);
  expect(await store.claim()).toEqual([]); // later replies cannot pass a leased reply
  await store.fail(firstReply!, "rate_limit", Date.now() + 60_000);
  expect(await store.claim()).toEqual([]);
  await db
    .prepare(
      "UPDATE planning_replies SET next_attempt_at = 0 WHERE input_id = ?",
    )
    .bind(firstReply!.input_id)
    .run();
  const [retry] = await store.claim();
  await store.fail(retry!, "permission", null); // a permanent failure must not block the conversation
  const [secondReply] = await store.claim();
  expect(secondReply?.run_id).toBe(second);
  expect(commentBody("https://tailos.app", secondReply!)).toContain(
    "@\u200beveryone",
  );
  expect(commentBody("https://tailos.app", secondReply!)).toContain(
    `tailos:plan:${second}:input:`,
  );
  await store.complete(secondReply!, 501);
  const [thirdReply] = await store.claim();
  expect(thirdReply?.reply_body).toContain("agent_failed");
  await store.complete(thirdReply!, 502);
  expect(await store.claim()).toEqual([]);
  expect(
    await acceptPlanningInput(db, { ...input, deliveryId: "very-late-replay" }),
  ).toEqual(receipts[0]);
  expect(await dispatchPlanningInputs(db)).toEqual([]);
});

test("guides before planning and isolates owner, project and repository identity", async (t) => {
  const db = await planningDb(t);
  await acceptPlanningInput(db, {
    ...input,
    start: false,
    body: "@tailos please help",
  });
  expect(await dispatchPlanningInputs(db)).toEqual([]);
  const store = planningReplyStore(db);
  await sendIssueNotifications(
    store,
    "https://tailos.app",
    async (_target, _marker, body) => {
      expect(body).toContain("@\u200btailos plan");
      return 1;
    },
  );
  await acceptPlanningInput(db, {
    ...input,
    commentId: 101,
    deliveryId: "start",
  });
  for (const change of [
    { ownerId: "other" },
    { projectId: "00000000-0000-4000-8000-000000000002", repositoryId: 4 },
    { repositoryId: 4 },
  ]) {
    await acceptPlanningInput(db, {
      ...input,
      ...change,
      deliveryId: crypto.randomUUID(),
    });
  }
  // The mismatched Project/repository tuple must not start a Run.
  expect(await dispatchPlanningInputs(db)).toHaveLength(3);
  await expect(
    acceptPlanningInput(db, { ...input, ownerId: "wrong" }),
  ).rejects.toThrow("original scope");
});

test("recovers reply leases and retries without rerunning the agent", async (t) => {
  const db = await planningDb(t);
  await acceptPlanningInput(db, { ...input, start: false });
  const store = planningReplyStore(db);
  const [stale] = await store.claim();
  await db.prepare("UPDATE planning_replies SET lease_until = 0").run();
  const [recovered] = await store.claim();
  await store.complete(stale!, 9);
  expect(await store.claim()).toEqual([]);
  await store.fail(recovered!, "transient", 0);
  await sendIssueNotifications(store, "https://tailos.app", async () => {
    throw new NotificationError("rate_limit", Date.now() + 60_000);
  });
  expect(await store.claim()).toEqual([]);
  expect(
    await db
      .prepare("SELECT error_category FROM planning_replies")
      .first("error_category"),
  ).toBe("rate_limit");
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(0);
});

test("rolls back message and input assignment if run creation fails", async (t) => {
  const db = await planningDb(t);
  await acceptPlanningInput(db, input);
  await db
    .prepare(
      "CREATE TRIGGER reject_plan BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'injected'); END",
    )
    .run();
  await expect(dispatchPlanningInputs(db)).rejects.toThrow();
  expect(
    await db.prepare("SELECT state FROM planning_inbox").first("state"),
  ).toBe("pending");
  expect(
    await db.prepare("SELECT count(*) AS n FROM session_messages").first("n"),
  ).toBe(0);
  await db.prepare("DROP TRIGGER reject_plan").run();
  expect(await dispatchPlanningInputs(db)).toHaveLength(1);
});

test("actor removal applies to future acceptance while already accepted pending inputs still run", async (t) => {
  const { d1Projects } = await import("./projects.ts");
  const db = await planningDb(t);
  const store = d1Projects(db);
  await acceptPlanningInput(db, input);
  const [first] = await dispatchPlanningInputs(db);
  await acceptPlanningInput(db, {
    ...input,
    commentId: 101,
    deliveryId: "accepted-follow-up",
    start: false,
  });
  const current = (await store.list()).find(
    (p) => p.project.id === input.projectId,
  )!;
  const { id: _id, ...settings } = current.project;
  await store.update(
    input.projectId,
    1,
    {
      ...settings,
      allowedActors: ["replacement"],
      agentNetworkAccess: true,
      maxRunMinutes: 3,
    },
    "operator",
  );
  await db
    .prepare("UPDATE runs SET status = 'failed' WHERE id = ?")
    .bind(first)
    .run();
  const [second] = await dispatchPlanningInputs(db);
  expect(second).toBeTruthy();
  expect(
    await db
      .prepare("SELECT state FROM planning_inbox WHERE comment_id = 101")
      .first("state"),
  ).toBe("assigned");
  const row = await db
    .prepare(
      "SELECT execution_context, deadline_at - created_at AS timeout FROM runs WHERE id = ?",
    )
    .bind(second)
    .first<{ execution_context: string; timeout: number }>();
  expect(JSON.parse(row!.execution_context).repository.agentNetworkAccess).toBe(
    true,
  );
  expect(row!.timeout).toBe(180_000);
});

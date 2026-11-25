import { expect, test, type TestContext } from "vitest";
import { createTestBindings, createTestDb } from "./testing.ts";
import { d1Projects } from "./projects.ts";
import { d1Routines } from "./routines.ts";
import {
  admitIssueMessage,
  admitSessionMessage,
  dispatchSessionInbox,
  latestCommentSession,
  latestTurnContext,
} from "./session-inbox.ts";
import { listDueRunIds } from "./run-recovery.ts";
import {
  ProjectChanged,
  type IssueMessage,
} from "@/application/triggers/admit-trigger.ts";
import { planningPrompt } from "@/application/routines/routines.ts";

const owner = "00000000-0000-4000-8000-000000000001";
const settings = {
  name: "Project",
  repository: "owner/repo",
  repositoryId: 42,
  installationId: 19,
  maxRunMinutes: 2,
};

async function fixture(t: TestContext) {
  const db = await createTestDb(t);
  const project = await d1Projects(db).create(settings, owner);
  const routine = (await d1Routines(db).save(owner, project.project.id, {
    name: "Planning",
    enabled: true,
    trigger: { version: 1, type: "github.issue-comment", command: "plan" },
    allowedActors: ["allowed"],
    engine: "codex",
    prompt: planningPrompt,
  }))!;
  const message = (comment: number, body = "@tailos plan"): IssueMessage => ({
    source: "github.issue-comment",
    idempotencyKey: JSON.stringify([project.project.id, routine.id, comment]),
    deliveryId: `delivery-${comment}`,
    ownerId: owner,
    projectId: project.project.id,
    projectRevision: 1,
    routineId: routine.id,
    routineRevision: 1,
    repositoryId: 42,
    issueNumber: 3,
    startsSession: true,
    initialTitle: "Issue",
    triggerMetadata: "{}",
    target: "{}",
    body,
    executionContext: JSON.stringify({
      version: 1,
      engine: "fake",
      trigger: { kind: "github.issue-comment", issueNumber: 3 },
    }),
    timeoutMs: 60_000,
  });
  return { db, project, routine, message };
}

test("one Session per Routine and issue takes each message once, and a message waits for the Turn in progress", async (t) => {
  const { db, message } = await fixture(t);
  const receipts = await Promise.all([
    admitIssueMessage(db, message(100)),
    admitIssueMessage(db, message(100)),
  ]);
  expect(receipts[0]?.sessionId).toBe(receipts[1]?.sessionId);
  expect(receipts.filter((r) => r?.started)).toHaveLength(1);
  expect(
    await db.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(1);
  const [first] = receipts;
  expect(first?.disposition).toBe("started");
  expect(await listDueRunIds(db, Date.now())).toEqual([first?.runId]);

  const waiting = await admitIssueMessage(db, {
    ...message(101, "@tailos option B"),
    startsSession: false,
  });
  expect(waiting).toEqual({
    sessionId: first?.sessionId,
    disposition: "queued",
  });
  expect(await dispatchSessionInbox(db)).toEqual([]);

  await db
    .prepare(
      "UPDATE runs SET status = 'succeeded', finished_at = 1 WHERE id = ?",
    )
    .bind(first?.runId)
    .run();
  const before = Date.now();
  const [next] = await dispatchSessionInbox(db);
  const run = await db
    .prepare(
      `SELECT r.session_id AS sessionId, r.deadline_at AS deadlineAt, m.body, m.seq FROM runs r
      JOIN session_messages m ON m.id = r.start_message_id WHERE r.id = ?`,
    )
    .bind(next)
    .first<{
      sessionId: string;
      deadlineAt: number;
      body: string;
      seq: number;
    }>();
  // The time limit starts with the Turn, not when the message arrived.
  expect(run).toMatchObject({
    sessionId: first?.sessionId,
    body: "@tailos option B",
    seq: 2,
  });
  expect(run!.deadlineAt).toBeGreaterThanOrEqual(before + 60_000);
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM issue_notifications")
      .first("n"),
  ).toBe(2);
  // The same comment again changes nothing.
  expect(await admitIssueMessage(db, message(101))).toEqual({
    sessionId: first?.sessionId,
    runId: next,
    disposition: "started",
  });
});

test("a comment that only continues needs a Session, and stale or foreign settings are told apart", async (t) => {
  const { db, project, routine, message } = await fixture(t);
  expect(
    await admitIssueMessage(db, { ...message(100), startsSession: false }),
  ).toBeNull();
  expect(
    await db.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(0);
  await expect(
    admitIssueMessage(db, { ...message(100), routineRevision: 2 }),
  ).rejects.toBeInstanceOf(ProjectChanged);
  await admitIssueMessage(db, message(100));
  await expect(
    admitIssueMessage(db, { ...message(100), ownerId: "other" }),
  ).rejects.not.toBeInstanceOf(ProjectChanged);
  expect(
    await latestCommentSession(db, {
      ownerId: owner,
      projectId: project.project.id,
      repositoryId: 42,
      issueNumber: 3,
    }),
  ).toEqual({ routineId: routine.id });
});

test("messages of a deleted Project wait without becoming Turns", async (t) => {
  const { db, project, message } = await fixture(t);
  const first = await admitIssueMessage(db, message(100));
  await admitIssueMessage(db, { ...message(101), startsSession: false });
  await d1Projects(db).remove(project.project.id, 1, owner);
  await db
    .prepare("UPDATE runs SET status = 'failed', finished_at = 1 WHERE id = ?")
    .bind(first?.runId)
    .run();
  expect(await dispatchSessionInbox(db)).toEqual([]);
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(1);
});

test("migration gives each Project a plan Routine and keeps started planning conversations", async (t) => {
  const id = crypto.randomUUID();
  const sessions = {
    started: crypto.randomUUID(),
    guided: crypto.randomUUID(),
  };
  const { DB } = await createTestBindings(t, {
    beforeMigration: async (db, file) => {
      if (!file.startsWith("0013_")) return;
      await db
        .prepare(
          "INSERT INTO projects (id, name, owner_id, repository_id, config, created_at, updated_at, updated_by) VALUES (?, 'Project', ?, 42, ?, 1, 1, ?)",
        )
        .bind(
          id,
          owner,
          JSON.stringify({ ...settings, id, allowedActors: ["planner"] }),
          owner,
        )
        .run();
      for (const [issue, session, started] of [
        [3, sessions.started, 1],
        [4, sessions.guided, 0],
      ] as const) {
        await db
          .prepare(
            "INSERT INTO sessions (id, owner_id, project_id, title, created_at) VALUES (?, ?, ?, 'Plan', 1)",
          )
          .bind(session, owner, id)
          .run();
        await db
          .prepare(
            "INSERT INTO planning_issues (scope, session_id, started) VALUES (?, ?, ?)",
          )
          .bind(JSON.stringify([owner, id, 42, issue]), session, started)
          .run();
      }
    },
  });
  const routines = (await d1Routines(DB).list(owner, id))!;
  expect(routines).toEqual([
    expect.objectContaining({
      name: "Issue planning",
      enabled: true,
      trigger: { version: 1, type: "github.issue-comment", command: "plan" },
      allowedActors: ["planner"],
      engine: "codex",
      prompt: planningPrompt,
    }),
  ]);
  const [project] = await d1Projects(DB).list();
  expect(project.project).not.toHaveProperty("allowedActors");
  expect(
    await DB.prepare("SELECT count(*) AS n FROM project_changes").first("n"),
  ).toBe(1);
  expect(
    (await DB.prepare("SELECT session_id FROM routine_sessions").all()).results,
  ).toEqual([{ session_id: sessions.started }]);
  expect(
    await DB.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'planning_terminal'",
    ).first("n"),
  ).toBe(0);
});

test("a message from the Session's page starts its next Turn only while the Session is idle", async (t) => {
  const { db, project, message } = await fixture(t);
  const first = await admitIssueMessage(db, message(100));
  const sessionId = first!.sessionId;
  const send = (requestId: string, revision = 1) =>
    admitSessionMessage(db, {
      ownerId: owner,
      projectId: project.project.id,
      projectRevision: revision,
      sessionId,
      requestId,
      body: "Use option B",
      executionContext: JSON.stringify({ version: 1, engine: "fake" }),
      timeoutMs: 60_000,
    });
  const request = crypto.randomUUID();
  // The Turn from the issue is still running.
  expect(await send(request)).toBe("busy");
  await db
    .prepare(
      "UPDATE runs SET status = 'succeeded', finished_at = 1 WHERE id = ?",
    )
    .bind(first!.runId)
    .run();
  await expect(send(request, 2)).rejects.toBeInstanceOf(ProjectChanged);
  const started = await send(request);
  expect(started).toEqual({ runId: expect.any(String) });
  // A resend of the same request is the same Turn.
  expect(await send(request)).toEqual(started);
  const run = await db
    .prepare(
      `SELECT m.author_kind AS author, m.body FROM runs r JOIN session_messages m ON m.id = r.start_message_id WHERE r.id = ?`,
    )
    .bind(started !== "busy" && started !== "not_found" ? started.runId : "")
    .first();
  expect(run).toEqual({ author: "user", body: "Use option B" });
  // Only Turns from the issue show on the issue.
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM issue_notifications")
      .first("n"),
  ).toBe(1);
  expect(
    await admitSessionMessage(db, {
      ownerId: "other",
      projectId: project.project.id,
      projectRevision: 1,
      sessionId,
      requestId: crypto.randomUUID(),
      body: "x",
      executionContext: "{}",
      timeoutMs: 60_000,
    }),
  ).toBe("not_found");
  expect(
    await latestTurnContext(db, {
      ownerId: owner,
      projectId: project.project.id,
      sessionId,
    }),
  ).toBe(JSON.stringify({ version: 1, engine: "fake" }));
});

test("a Turn and its status comment are saved together", async (t) => {
  const { db, message } = await fixture(t);
  await db
    .prepare(
      "CREATE TRIGGER reject_notification BEFORE INSERT ON issue_notifications BEGIN SELECT RAISE(ABORT, 'notification failure'); END",
    )
    .run();
  await expect(admitIssueMessage(db, message(100))).rejects.toThrow(
    "notification failure",
  );
  for (const table of ["runs", "sessions", "session_inbox"])
    expect(
      await db.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"),
    ).toBe(0);
});

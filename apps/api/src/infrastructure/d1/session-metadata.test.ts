import { expect, test } from "vitest";
import { createTestBindings, createTestDb } from "./testing.ts";
import { admitTrigger } from "./trigger-admission.ts";
import { advanceRun } from "./run-execution.ts";
import { stageRunPublication } from "./run-publication.ts";

const input = {
  ownerId: "operator",
  source: "test",
  idempotencyKey: "delivery",
  concurrencyKey: "issue/3",
  prompt: "Work",
  timeoutMs: 60_000,
  executionContext: JSON.stringify({ version: 1, engine: "fake" }),
  initialTitle: "Issue title",
  triggerMetadata: JSON.stringify({
    kind: "github.issue",
    repository: "owner/repo",
    number: 3,
  }),
};

test("failed and title-only-invalid replies leave the session eligible for a later valid title", async (t) => {
  const db = await createTestDb(t);
  for (const failed of [true, false]) {
    const admitted = await admitTrigger(db, {
      ...input,
      idempotencyKey: String(failed),
      concurrencyKey: String(failed),
    });
    await advanceRun(db, admitted.runId, {
      start: async () =>
        failed
          ? { status: "failed", errorCode: "agent_failed", events: [] }
          : {
              status: "succeeded",
              reply: "Done",
              sessionTitle: "bad\ntitle",
              events: [],
            },
      poll: async () => ({ status: "running" }),
    });
    expect(
      await db
        .prepare("SELECT title, title_generated FROM sessions WHERE id = ?")
        .bind(admitted.sessionId)
        .first(),
    ).toEqual({ title: "Issue title", title_generated: 0 });
    const messageId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          "INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at) SELECT ?, ?, max(seq) + 1, 'user', 'Retry', ? FROM session_messages WHERE session_id = ?",
        )
        .bind(messageId, admitted.sessionId, Date.now(), admitted.sessionId),
      db
        .prepare(
          "INSERT INTO runs (id, session_id, start_message_id, status, execution_context, deadline_at, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
        )
        .bind(
          runId,
          admitted.sessionId,
          messageId,
          input.executionContext,
          Date.now() + 60_000,
          Date.now(),
        ),
    ]);
    await advanceRun(db, runId, {
      start: async () => ({
        status: "succeeded",
        reply: "Retried",
        sessionTitle: "Recovered title",
        events: [],
      }),
      poll: async () => ({ status: "running" }),
    });
    expect(
      await db
        .prepare("SELECT title, title_generated FROM sessions WHERE id = ?")
        .bind(admitted.sessionId)
        .first(),
    ).toEqual({ title: "Recovered title", title_generated: 1 });
  }
});

test("activity follows messages and Run transitions while retries and title confirmation are idempotent", async (t) => {
  const db = await createTestDb(t);
  const admitted = await admitTrigger(db, input);
  const read = () =>
    db
      .prepare(
        "SELECT title, title_generated, created_at, updated_at FROM sessions WHERE id = ?",
      )
      .bind(admitted.sessionId)
      .first();
  const initial = await read();
  expect(initial).toMatchObject({ title: "Issue title", title_generated: 0 });
  expect(initial?.updated_at).toBe(initial?.created_at);
  await admitTrigger(db, input);
  expect(await read()).toEqual(initial);
  await advanceRun(db, admitted.runId, {
    start: async () => ({
      status: "succeeded",
      reply: "Done",
      sessionTitle: "  Conversation title  ",
      events: [],
    }),
    poll: async () => ({ status: "running" }),
  });
  expect(await read()).toMatchObject({
    title: "Conversation title",
    title_generated: 1,
  });
  const completed = await read();
  await db
    .prepare("UPDATE runs SET next_action_at = 999 WHERE id = ?")
    .bind(admitted.runId)
    .run();
  expect(await read()).toEqual(completed);
  await db
    .prepare(
      "INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at) VALUES ('second', ?, 3, 'user', 'Next', ?)",
    )
    .bind(admitted.sessionId, Number(completed?.updated_at) + 10)
    .run();
  expect((await read())?.updated_at).toBe(Number(completed?.updated_at) + 10);
  await db
    .prepare(
      "INSERT INTO runs (id, session_id, start_message_id, status, execution_context, deadline_at, created_at) VALUES ('run2', ?, 'second', 'queued', ?, ?, ?)",
    )
    .bind(
      admitted.sessionId,
      input.executionContext,
      Date.now() + 60_000,
      Number(completed?.updated_at) + 20,
    )
    .run();
  await advanceRun(db, "run2", {
    start: async () => ({
      status: "succeeded",
      reply: "Next done",
      sessionTitle: "Do not rename",
      events: [],
    }),
    poll: async () => ({ status: "running" }),
  });
  expect(await read()).toMatchObject({
    title: "Conversation title",
    title_generated: 1,
  });
});

test("only an accepted publication checkpoint confirms a title, which survives a publication failure", async (t) => {
  const db = await createTestDb(t);
  const admitted = await admitTrigger(db, input);
  const branch = `tailos/issue-3/${crypto.randomUUID()}`;
  const sha = "a".repeat(40);
  await db
    .prepare("UPDATE runs SET status = 'running', step_state = ? WHERE id = ?")
    .bind(JSON.stringify({ version: 2, branch, baseSha: sha }), admitted.runId)
    .run();
  const checkpoint = {
    kind: "checked" as const,
    branch,
    baseSha: sha,
    tree: sha,
    digest: "b".repeat(64),
    headline: "feat: work",
    reply: "Done",
    sessionTitle: "Work summary",
    events: [],
  };
  expect(
    await stageRunPublication(db, admitted.runId, {
      ...checkpoint,
      branch: "other",
    }),
  ).toBe(false);
  expect(
    await db
      .prepare("SELECT title_generated FROM sessions WHERE id = ?")
      .bind(admitted.sessionId)
      .first("title_generated"),
  ).toBe(0);
  expect(await stageRunPublication(db, admitted.runId, checkpoint)).toBe(true);
  expect(await stageRunPublication(db, admitted.runId, checkpoint)).toBe(true);
  expect(
    await stageRunPublication(db, admitted.runId, {
      ...checkpoint,
      sessionTitle: "Other title",
    }),
  ).toBe(false);
  await advanceRun(db, admitted.runId, {
    start: async () => ({ status: "running" }),
    poll: async () => ({
      status: "failed",
      errorCode: "agent_failed",
      events: [],
    }),
  });
  expect(
    await db
      .prepare("SELECT title, title_generated FROM sessions WHERE id = ?")
      .bind(admitted.sessionId)
      .first(),
  ).toEqual({ title: "Work summary", title_generated: 1 });
  expect(
    await db
      .prepare("SELECT status FROM runs WHERE id = ?")
      .bind(admitted.runId)
      .first("status"),
  ).toBe("failed");
});

test("migration backfills only persisted evidence and leaves unknown origins unset", async (t) => {
  const { DB: db } = await createTestBindings(t, {
    beforeMigration: async (db, file) => {
      if (file !== "0009_session_metadata.sql") return;
      const target = JSON.stringify({
        kind: "github.issue",
        repositoryId: 1,
        issueNumber: 3,
      });
      const context = JSON.stringify({
        repository: {
          repository: "owner/repo",
          repositoryId: 1,
          issueNumber: 3,
        },
      });
      await db.batch([
        db
          .prepare(
            "INSERT INTO sessions (id, owner_id, target, created_at) VALUES ('legacy', 'owner', ?, 10), ('unknown', 'owner', 'invalid-json', 1)",
          )
          .bind(target),
        db.prepare(
          "INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at) VALUES ('message', 'legacy', 1, 'user', 'Work', 20)",
        ),
        db
          .prepare(
            "INSERT INTO runs (id, session_id, start_message_id, status, execution_context, deadline_at, created_at, finished_at) VALUES ('run', 'legacy', 'message', 'succeeded', ?, 99, 30, 40)",
          )
          .bind(context),
        db.prepare(
          "INSERT INTO planning_issues (scope, session_id) VALUES ('scope', 'legacy')",
        ),
        db
          .prepare(
            "INSERT INTO planning_inbox (id, scope, comment_id, actor, url, body, execution_context, timeout_ms, received_at, state, run_id) VALUES (1, 'scope', 1, 'owner', 'https://github.com', 'plan', ?, 99, 15, 'completed', 'run')",
          )
          .bind(context),
        db.prepare(
          "INSERT INTO planning_snapshots (run_id, input_id, title, body, base_sha, conversation, created_at) VALUES ('run', 1, 'Saved Issue title', '', '', '[]', 25)",
        ),
      ]);
    },
  });
  const legacy = await db
    .prepare(
      "SELECT title, title_generated, trigger_metadata, updated_at FROM sessions WHERE id = 'legacy'",
    )
    .first<{
      title: string;
      title_generated: number;
      trigger_metadata: string;
      updated_at: number;
    }>();
  expect(legacy).toMatchObject({
    title: "Saved Issue title",
    title_generated: 0,
    updated_at: 40,
  });
  expect(JSON.parse(legacy!.trigger_metadata)).toEqual({
    kind: "github.issue",
    repository: "owner/repo",
    number: 3,
    url: "https://github.com/owner/repo/issues/3",
  });
  expect(
    await db
      .prepare(
        "SELECT title, trigger_metadata, updated_at FROM sessions WHERE id = 'unknown'",
      )
      .first(),
  ).toEqual({ title: "新しい会話", trigger_metadata: null, updated_at: 1 });
});

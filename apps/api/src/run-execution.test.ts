import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "./db/testing.ts";
import {
  advanceRun,
  type RunnerDriver,
  type RunRequest,
} from "./run-execution.ts";
import { admitTrigger } from "./trigger-admission.ts";

const unexpectedPoll = async () => {
  throw new Error("Unexpected poll");
};

const request = {
  source: "test",
  idempotencyKey: "delivery",
  ownerId: "owner",
  concurrencyKey: "issue",
  prompt: "Fix the issue",
  executionContext: '{"version":1,"engine":"fake"}',
  timeoutMs: 60_000,
};

test("claims a run once and stores the agent reply with its terminal result", async (t) => {
  const db = await createTestDb(t);
  const { runId, sessionId } = await admitTrigger(db, request);
  let dispatched = 0;
  const run = async (job: RunRequest) => {
    dispatched++;
    assert.equal(job.prompt, request.prompt);
    assert.equal(job.runId, runId);
    assert.equal(
      await db
        .prepare("SELECT status FROM runs WHERE id = ?")
        .bind(runId)
        .first("status"),
      "running",
    );
    return { status: "succeeded" as const, reply: "All done", events: [] };
  };

  const driver = { start: run, poll: unexpectedPoll };
  assert.deepEqual(await advanceRun(db, runId, driver), {
    status: "succeeded",
  });
  assert.equal(await advanceRun(db, runId, driver), undefined);
  assert.equal(dispatched, 1);

  const messages = await db
    .prepare(
      "SELECT seq, author_kind, body, run_id FROM session_messages WHERE session_id = ? ORDER BY seq",
    )
    .bind(sessionId)
    .all();
  assert.deepEqual(messages.results, [
    { seq: 1, author_kind: "automation", body: "Fix the issue", run_id: null },
    { seq: 2, author_kind: "agent", body: "All done", run_id: runId },
  ]);
  const record = await db
    .prepare("SELECT status, result FROM runs WHERE id = ?")
    .bind(runId)
    .first();
  assert.deepEqual(record, {
    status: "succeeded",
    result: '{"version":1,"kind":"completed"}',
  });
});

test("records an expired or invalid run without starting a runner", async (t) => {
  const db = await createTestDb(t);
  const expired = await admitTrigger(db, { ...request, timeoutMs: -1 });
  const invalid = await admitTrigger(db, {
    ...request,
    idempotencyKey: "invalid",
    concurrencyKey: "different-issue",
    executionContext: "{",
  });
  for (const [runId, errorCode] of [
    [expired.runId, "deadline_exceeded"],
    [invalid.runId, "invalid_execution_context"],
  ]) {
    let started = false;
    assert.equal(
      (
        await advanceRun(db, runId, {
          async start() {
            started = true;
            return { status: "succeeded", reply: "unexpected", events: [] };
          },
          poll: unexpectedPoll,
        })
      )?.status,
      "failed",
    );
    assert.equal(started, false);
    assert.equal(
      await db
        .prepare("SELECT error_code FROM runs WHERE id = ?")
        .bind(runId)
        .first("error_code"),
      errorCode,
    );
  }
});

test("finalizes the run as failed if D1 cannot store the reply", async (t) => {
  const db = await createTestDb(t);
  const { runId, sessionId } = await admitTrigger(db, request);
  await db
    .prepare(`CREATE TRIGGER reject_agent_reply BEFORE INSERT ON session_messages
    WHEN NEW.author_kind = 'agent' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    .run();

  assert.equal(
    (
      await advanceRun(db, runId, {
        start: async () => ({
          status: "succeeded",
          reply: "Unstored reply",
          events: [],
        }),
        poll: unexpectedPoll,
      })
    )?.status,
    "failed",
  );
  assert.deepEqual(
    await db
      .prepare("SELECT status, error_code FROM runs WHERE id = ?")
      .bind(runId)
      .first(),
    { status: "failed", error_code: "persistence_failed" },
  );
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) AS count FROM session_messages WHERE session_id = ?",
      )
      .bind(sessionId)
      .first("count"),
    1,
  );
});

test("polls the existing job after a lost start response without submitting it again", async (t) => {
  const db = await createTestDb(t);
  const { runId } = await admitTrigger(db, request);
  let started = 0;
  const driver: RunnerDriver = {
    async start() {
      started++;
      throw new Error("The acknowledgement was lost");
    },
    async poll(id) {
      assert.equal(id, runId);
      return { status: "succeeded", reply: "Recovered", events: [] };
    },
  };

  const first = await advanceRun(db, runId, driver);
  assert.ok(first?.status === "running");
  assert.equal(
    await db
      .prepare("SELECT next_action_at FROM runs WHERE id = ?")
      .bind(runId)
      .first("next_action_at"),
    first.nextActionAt,
  );
  assert.deepEqual(await advanceRun(db, runId, driver), {
    status: "succeeded",
  });
  assert.equal(started, 1);
  assert.equal(
    await db
      .prepare("SELECT next_action_at FROM runs WHERE id = ?")
      .bind(runId)
      .first("next_action_at"),
    null,
  );
});

test("ends a run whose container disappeared without creating a replacement", async (t) => {
  const db = await createTestDb(t);
  const { runId } = await admitTrigger(db, request);
  await db
    .prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .bind(runId)
    .run();

  let started = false;
  const driver: RunnerDriver = {
    async start() {
      started = true;
      return { status: "running" };
    },
    async poll() {
      return { status: "failed", errorCode: "runner_lost" };
    },
  };
  assert.deepEqual(await advanceRun(db, runId, driver), { status: "failed" });
  assert.equal(started, false);
  assert.equal(
    await db
      .prepare("SELECT error_code FROM runs WHERE id = ?")
      .bind(runId)
      .first("error_code"),
    "runner_lost",
  );
});

test("records artifact_write_failed when R2 rejects a successful result", async (t) => {
  const db = await createTestDb(t);
  const { runId, sessionId } = await admitTrigger(db, request);
  const artifacts = {
    async get() {
      return null;
    },
    async put() {
      throw new Error("R2 unavailable");
    },
  };
  assert.equal(
    (
      await advanceRun(
        db,
        runId,
        {
          start: async () => ({
            status: "succeeded",
            reply: "Unstored",
            events: [],
          }),
          poll: unexpectedPoll,
        },
        artifacts,
      )
    )?.status,
    "failed",
  );
  assert.equal(
    await db
      .prepare("SELECT error_code FROM runs WHERE id = ?")
      .bind(runId)
      .first("error_code"),
    "artifact_write_failed",
  );
  assert.equal(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?",
      )
      .bind(sessionId)
      .first("count"),
    1,
  );
});

test("reconciles a published pull request after the deadline without restarting the runner", async (t) => {
  const db = await createTestDb(t);
  const { runId } = await admitTrigger(db, {
    ...request,
    timeoutMs: -1,
    executionContext: JSON.stringify({
      version: 1,
      engine: "codex",
      connectionId: "codex/default",
      repository: {
        repository: "owner/private",
        repositoryId: 42,
        installationId: 2,
        issueNumber: 8,
        defaultBranch: "main",
        triggerLabel: "meguri:run",
      },
    }),
  });
  const publication = {
    kind: "pushed",
    branch: `meguri/issue-8/${runId}`,
    sha: "a".repeat(40),
    reply: "Completed",
    events: [],
  };
  await db
    .prepare("UPDATE runs SET status = 'running', step_state = ? WHERE id = ?")
    .bind(
      JSON.stringify({ version: 1, pendingPublication: publication }),
      runId,
    )
    .run();
  const result = await advanceRun(db, runId, {
    async start() {
      throw new Error("must not restart");
    },
    async poll(id, _context, deadline, stepState) {
      assert.equal(id, runId);
      assert.ok(deadline < Date.now());
      assert.match(stepState ?? "", /pendingPublication/);
      return {
        status: "succeeded",
        reply: publication.reply,
        events: [],
        publicationResult: {
          kind: "pull_request",
          url: "https://github.com/owner/private/pull/5",
          branch: publication.branch,
          sha: publication.sha,
        },
      };
    },
  });
  assert.deepEqual(result, { status: "succeeded" });
  const stored = await db
    .prepare("SELECT result, step_state FROM runs WHERE id = ?")
    .bind(runId)
    .first();
  assert.match(String(stored?.result), /pull\/5/);
  assert.equal(stored?.step_state, '{"version":1}');
});

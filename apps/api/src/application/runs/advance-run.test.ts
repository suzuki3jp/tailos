import { assert, expect, test } from "vitest";
import type { RunnerJob } from "@meguri/core/runner";
import { createTestDb } from "../../infrastructure/d1/testing.ts";
import { advanceRun } from "../../infrastructure/d1/run-execution.ts";
import { type RunnerDriver } from "./advance-run.ts";
import { admitTrigger } from "../../infrastructure/d1/trigger-admission.ts";

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
  const run = async (job: RunnerJob) => {
    dispatched++;
    expect(job.prompt).toBe(request.prompt);
    expect(job.runId).toBe(runId);
    expect(
      await db
        .prepare("SELECT status FROM runs WHERE id = ?")
        .bind(runId)
        .first("status"),
    ).toBe("running");
    return { status: "succeeded" as const, reply: "All done", events: [] };
  };

  const driver = { start: run, poll: unexpectedPoll };
  expect(await advanceRun(db, runId, driver)).toStrictEqual({
    status: "succeeded",
  });
  expect(await advanceRun(db, runId, driver)).toBe(undefined);
  expect(dispatched).toBe(1);

  const messages = await db
    .prepare(
      "SELECT seq, author_kind, body, run_id FROM session_messages WHERE session_id = ? ORDER BY seq",
    )
    .bind(sessionId)
    .all();
  expect(messages.results).toStrictEqual([
    { seq: 1, author_kind: "automation", body: "Fix the issue", run_id: null },
    { seq: 2, author_kind: "agent", body: "All done", run_id: runId },
  ]);
  const record = await db
    .prepare("SELECT status, result FROM runs WHERE id = ?")
    .bind(runId)
    .first();
  expect(record).toStrictEqual({
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
    expect(
      (
        await advanceRun(db, runId, {
          async start() {
            started = true;
            return { status: "succeeded", reply: "unexpected", events: [] };
          },
          poll: unexpectedPoll,
        })
      )?.status,
    ).toBe("failed");
    expect(started).toBe(false);
    expect(
      await db
        .prepare("SELECT error_code FROM runs WHERE id = ?")
        .bind(runId)
        .first("error_code"),
    ).toBe(errorCode);
  }
});

test("finalizes the run as failed if D1 cannot store the reply", async (t) => {
  const db = await createTestDb(t);
  const { runId, sessionId } = await admitTrigger(db, request);
  await db
    .prepare(`CREATE TRIGGER reject_agent_reply BEFORE INSERT ON session_messages
    WHEN NEW.author_kind = 'agent' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    .run();

  expect(
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
  ).toBe("failed");
  expect(
    await db
      .prepare("SELECT status, error_code FROM runs WHERE id = ?")
      .bind(runId)
      .first(),
  ).toStrictEqual({ status: "failed", error_code: "persistence_failed" });
  expect(
    await db
      .prepare(
        "SELECT count(*) AS count FROM session_messages WHERE session_id = ?",
      )
      .bind(sessionId)
      .first("count"),
  ).toBe(1);
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
      expect(id).toBe(runId);
      return { status: "succeeded", reply: "Recovered", events: [] };
    },
  };

  const first = await advanceRun(db, runId, driver);
  assert(first?.status === "running");
  expect(
    await db
      .prepare("SELECT next_action_at FROM runs WHERE id = ?")
      .bind(runId)
      .first("next_action_at"),
  ).toBe(first.nextActionAt);
  expect(await advanceRun(db, runId, driver)).toStrictEqual({
    status: "succeeded",
  });
  expect(started).toBe(1);
  expect(
    await db
      .prepare("SELECT next_action_at FROM runs WHERE id = ?")
      .bind(runId)
      .first("next_action_at"),
  ).toBe(null);
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
  expect(await advanceRun(db, runId, driver)).toStrictEqual({
    status: "failed",
  });
  expect(started).toBe(false);
  expect(
    await db
      .prepare("SELECT error_code FROM runs WHERE id = ?")
      .bind(runId)
      .first("error_code"),
  ).toBe("runner_lost");
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
  expect(
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
  ).toBe("failed");
  expect(
    await db
      .prepare("SELECT error_code FROM runs WHERE id = ?")
      .bind(runId)
      .first("error_code"),
  ).toBe("artifact_write_failed");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?",
      )
      .bind(sessionId)
      .first("count"),
  ).toBe(1);
});

test("recovers a completed job when the next alarm arrives after its deadline", async (t) => {
  const db = await createTestDb(t);
  const { runId } = await admitTrigger(db, request);
  const deadline = Date.now() - 1;
  await db
    .prepare("UPDATE runs SET status = 'running', deadline_at = ? WHERE id = ?")
    .bind(deadline, runId)
    .run();

  const result = await advanceRun(db, runId, {
    async start() {
      throw new Error("must not restart");
    },
    async poll() {
      return {
        status: "succeeded",
        reply: "Finished in time",
        events: [{ type: "job_succeeded", at: deadline - 1 }],
      };
    },
  });
  expect(result).toStrictEqual({ status: "succeeded" });
});

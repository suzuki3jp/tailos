import { assert, expect, test } from "vitest";
import type { RunnerJob } from "@meguri/core/runner";
import { createTestDb } from "../../infrastructure/d1/testing.ts";
import { executeRun } from "../../infrastructure/d1/run-execution.ts";
import { admitTrigger } from "../../infrastructure/d1/trigger-admission.ts";

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
    return { status: "succeeded", reply: "All done" } as const;
  };

  const statuses = await Promise.all([
    executeRun(db, runId, run),
    executeRun(db, runId, run),
  ]);
  assert(statuses.includes("succeeded"));
  expect(dispatched).toBe(1);
  expect(await executeRun(db, runId, run)).toBe("succeeded");
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
      await executeRun(db, runId, async () => {
        started = true;
        return { status: "succeeded", reply: "unexpected" };
      }),
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
    await executeRun(db, runId, async () => ({
      status: "succeeded",
      reply: "Unstored reply",
    })),
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

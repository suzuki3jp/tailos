import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerJob } from "@meguri/core/runner";
import { createTestDb } from "./db/testing.ts";
import { executeRun } from "./run-execution.ts";
import { admitTrigger } from "./trigger-admission.ts";

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
    assert.equal(job.prompt, request.prompt);
    assert.equal(job.runId, runId);
    assert.equal(
      await db
        .prepare("SELECT status FROM runs WHERE id = ?")
        .bind(runId)
        .first("status"),
      "running",
    );
    return { status: "succeeded", reply: "All done" } as const;
  };

  const statuses = await Promise.all([
    executeRun(db, runId, run),
    executeRun(db, runId, run),
  ]);
  assert.ok(statuses.includes("succeeded"));
  assert.equal(dispatched, 1);
  assert.equal(await executeRun(db, runId, run), "succeeded");
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
      await executeRun(db, runId, async () => {
        started = true;
        return { status: "succeeded", reply: "unexpected" };
      }),
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

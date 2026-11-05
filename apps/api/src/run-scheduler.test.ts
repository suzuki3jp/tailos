import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "./db/testing.ts";
import { rescheduleDueRuns } from "./run-scheduler.ts";
import { admitTrigger } from "./trigger-admission.ts";

test("reschedules overdue work after the original alarm request was lost", async (t) => {
  const db = await createTestDb(t);
  const create = (key: string) =>
    admitTrigger(db, {
      source: "test",
      ownerId: "owner",
      idempotencyKey: key,
      concurrencyKey: key,
      prompt: "Execute",
      executionContext: '{"version":1,"engine":"fake"}',
      timeoutMs: 60_000,
    });
  const queued = await create("lost-notification");
  const running = await create("lost-alarm");
  const completed = await create("completed");
  const future = await create("future");
  await db.batch([
    db
      .prepare("UPDATE runs SET status = 'running' WHERE id = ?")
      .bind(running.runId),
    db
      .prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?")
      .bind(completed.runId),
    db
      .prepare("UPDATE runs SET next_action_at = ? WHERE id = ?")
      .bind(Date.now() + 60_000, future.runId),
  ]);

  const scheduled: string[] = [];
  await assert.rejects(
    rescheduleDueRuns(db, async (id) => {
      if (id === queued.runId) throw new Error("Temporary outage");
      scheduled.push(id);
    }),
    /could not be scheduled/,
  );
  assert.deepEqual(scheduled, [running.runId]);

  const retried: string[] = [];
  await rescheduleDueRuns(db, async (id) => {
    retried.push(id);
  });
  assert.deepEqual(retried.sort(), [queued.runId, running.runId].sort());
});

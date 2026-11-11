import { listDueRunIds } from "@/infrastructure/d1/run-recovery.ts";
import { expect, test } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { rescheduleDueRuns } from "@/application/runs/recovery.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";

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
  const legacy = await create("legacy");
  const future = await create("future");
  await db.batch([
    db
      .prepare("UPDATE runs SET next_action_at = NULL WHERE id = ?")
      .bind(legacy.runId),
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
  await expect(
    rescheduleDueRuns(
      (now) => listDueRunIds(db, now),
      async (id) => {
        if (id === queued.runId) throw new Error("Temporary outage");
        scheduled.push(id);
      },
    ),
  ).rejects.toThrow(/could not be scheduled/);
  expect(scheduled.sort()).toStrictEqual([running.runId, legacy.runId].sort());

  const retried: string[] = [];
  await rescheduleDueRuns(
    (now) => listDueRunIds(db, now),
    async (id) => {
      retried.push(id);
    },
  );
  expect(retried.sort()).toStrictEqual(
    [queued.runId, running.runId, legacy.runId].sort(),
  );
});

import { expect, test } from "vitest";
import { createTestDb } from "#api/infrastructure/d1/testing.ts";
import { admitTrigger } from "#api/infrastructure/d1/trigger-admission.ts";

test("admission rolls back its writes if the origin event cannot be stored", async (t) => {
  const db = await createTestDb(t);
  await db
    .prepare(`CREATE TRIGGER reject_delivery BEFORE INSERT ON trigger_events
    BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    .run();
  await expect(
    admitTrigger(db, {
      source: "test",
      idempotencyKey: "delivery",
      ownerId: "owner",
      concurrencyKey: "target",
      prompt: "Implement the request",
      executionContext: "{}",
      timeoutMs: 60_000,
    }),
  ).rejects.toThrow(/test failure/);
  expect(
    await db.prepare("SELECT count(*) AS count FROM sessions").first("count"),
  ).toBe(0);
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestDb } from "./db/testing.ts";
import { admitTrigger } from "./trigger-admission.ts";

test("admission rolls back its writes if the origin event cannot be stored", async (t) => {
  const db = await createTestDb(t);
  await db
    .prepare(`CREATE TRIGGER reject_delivery BEFORE INSERT ON trigger_events
    BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    .run();
  await assert.rejects(
    admitTrigger(db, {
      source: "test",
      idempotencyKey: "delivery",
      ownerId: "owner",
      concurrencyKey: "target",
      prompt: "Implement the request",
      executionContext: "{}",
      timeoutMs: 60_000,
    }),
    /test failure/,
  );
  assert.equal(
    await db.prepare("SELECT count(*) AS count FROM sessions").first("count"),
    0,
  );
});

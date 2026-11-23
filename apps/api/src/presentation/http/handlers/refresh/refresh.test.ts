import { expect, test } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import app from "@/bootstrap/http.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { newRunLease } from "@/infrastructure/auth/run-lease.ts";

test("the Runner cannot obtain model credentials: the egress Worker adds them", async (t) => {
  const db = await createTestDb(t);
  const { runId } = await admitTrigger(db, {
    source: "test",
    idempotencyKey: "delivery",
    concurrencyKey: "target",
    ownerId: "owner",
    timeoutMs: 60_000,
    prompt: "Test",
    executionContext:
      '{"version":1,"engine":"codex","connectionId":"codex/c42c7de5-938d-4f93-a6af-d43bb0e7b65c"}',
  });
  await db
    .prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .bind(runId)
    .run();
  const response = await app.request(
    `/_runner/runs/${runId}/credentials`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + newRunLease(),
        "X-Tailos-Access-Version": crypto.randomUUID(),
      },
    },
    { DB: db, RUNNER: {} },
  );
  expect(response.status).toBe(404);
});

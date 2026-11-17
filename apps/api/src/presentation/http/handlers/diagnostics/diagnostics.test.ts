import { assert, expect, test } from "vitest";
import type { DiagnosticBatch } from "@tailos/core/diagnostics";
import { runTraceId } from "@tailos/core/diagnostics";
import app from "@/bootstrap/http.ts";
import { createTestBindings } from "@/infrastructure/d1/testing.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import {
  ingestDiagnostics,
  registerDiagnosticProducer,
} from "@/infrastructure/diagnostics/store.ts";

test("authorizes trace, cursor and body access with the existing operator session", async (t) => {
  const bindings = await createTestBindings(t);
  const env = {
    ...testLoginBindings(bindings.DB),
    RUN_ARTIFACTS: bindings.RUN_ARTIFACTS,
  };
  const operator = await createTestOperator(env);
  const run = await admitTrigger(bindings.DB, {
    ownerId: operator.id,
    source: "test",
    idempotencyKey: "delivery",
    concurrencyKey: "target",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  });
  const producer = crypto.randomUUID();
  await registerDiagnosticProducer(bindings.DB, run.runId, producer);
  const batch: DiagnosticBatch = {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId: producer,
    records: [
      {
        eventId: crypto.randomUUID(),
        spanId: crypto.randomUUID(),
        seq: 1,
        at: Date.now(),
        name: "output",
        attributes: {},
        body: "test output",
      },
    ],
  };
  await ingestDiagnostics(
    bindings.DB,
    bindings.RUN_ARTIFACTS,
    run.runId,
    producer,
    batch,
  );
  const base = "https://api.tailos.example/v1/diagnostics";
  const headers = { Cookie: operator.cookie };
  expect((await app.request(`${base}/traces`, undefined, env)).status).toBe(
    401,
  );
  const list = await app.request(
    `${base}/traces?runId=${run.runId}`,
    { headers },
    env,
  );
  expect(list.status).toBe(200);
  expect(list.headers.get("X-Request-ID")).toMatch(/^[a-f0-9-]{36}$/);
  const path = `${base}/traces/${encodeURIComponent(runTraceId(run.runId))}/events`;
  const events = await app.request(path, { headers }, env);
  expect(events.status).toBe(200);
  expect(await events.text()).toContain(batch.records[0]!.eventId);
  expect((await app.request(path + "?after=-1", { headers }, env)).status).toBe(
    400,
  );
  const body = await app.request(
    `${base}/artifacts/${batch.batchId}`,
    { headers },
    env,
  );
  expect(body.status).toBe(200);
  expect(body.headers.get("Cache-Control")).toContain("no-store");
  expect(await body.text()).toContain("test output");
  await bindings.DB.prepare(
    "UPDATE diagnostic_traces SET owner_id = 'other-owner' WHERE run_id = ?",
  )
    .bind(run.runId)
    .run();
  expect((await app.request(path, { headers }, env)).status).toBe(404);
  expect(
    (await app.request(`${base}/artifacts/${batch.batchId}`, { headers }, env))
      .status,
  ).toBe(404);
  const empty = await app.request(
    `${base}/traces?runId=${run.runId}`,
    { headers },
    env,
  );
  const result = await empty.json();
  assert(result && typeof result === "object" && "traces" in result);
  expect(JSON.stringify(result.traces)).not.toContain(run.runId);
});

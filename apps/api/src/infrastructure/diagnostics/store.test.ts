import { assert, expect, test } from "vitest";
import type { DiagnosticBatch } from "@tailos/core/diagnostics";
import { runTraceId } from "@tailos/core/diagnostics";
import {
  createTestBindings,
  createTestDb,
} from "@/infrastructure/d1/testing.ts";
import { advanceRun } from "@/infrastructure/d1/run-execution.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import {
  diagnosticReader,
  expireDiagnostics,
  ingestDiagnostics,
  registerDiagnosticProducer,
} from "@/infrastructure/diagnostics/store.ts";

const request = {
  source: "test",
  idempotencyKey: "delivery",
  ownerId: "owner",
  concurrencyKey: "target",
  prompt: "Make a change",
  executionContext: '{"version":1,"engine":"fake"}',
  timeoutMs: 60_000,
};

function batch(producerId: string): DiagnosticBatch {
  return {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId,
    records: [
      {
        eventId: crypto.randomUUID(),
        spanId: crypto.randomUUID(),
        seq: 1,
        at: Date.now(),
        name: "output",
        attributes: {},
        body: `// secretlint-disable\n日本語 ghp_${"a".repeat(36)}\nBearer opaque-value`,
      },
    ],
  };
}

test("journals trigger replay and coalescing atomically and rolls back failed required history", async (t) => {
  const db = await createTestDb(t);
  const run = await admitTrigger(db, request);
  expect(await admitTrigger(db, request)).toEqual(run);
  expect(
    (await admitTrigger(db, { ...request, idempotencyKey: "second" })).runId,
  ).toBe(run.runId);
  const links = await db
    .prepare("SELECT relation FROM diagnostic_links ORDER BY relation")
    .all();
  expect(links.results.map((r) => r.relation)).toEqual([
    "coalesces",
    "replays",
    "starts",
  ]);
  await db
    .prepare(`CREATE TRIGGER reject_journal BEFORE INSERT ON diagnostic_events WHEN NEW.name = 'run.started'
    BEGIN SELECT RAISE(ABORT, 'test journal unavailable'); END`)
    .run();
  let dispatched = 0;
  await expect(
    advanceRun(db, run.runId, {
      async start() {
        dispatched++;
        return { status: "running" };
      },
      async poll() {
        throw new Error("Unexpected poll");
      },
    }),
  ).rejects.toThrow();
  expect(dispatched).toBe(0);
  expect(
    await db
      .prepare("SELECT status FROM runs WHERE id = ?")
      .bind(run.runId)
      .first("status"),
  ).toBe("queued");
  expect(
    await db
      .prepare(
        "SELECT count(*) AS count FROM diagnostic_events WHERE name = 'run.started'",
      )
      .first("count"),
  ).toBe(0);
});

test("masks bodies before persistence, deduplicates ACK loss and enforces owner and expiry", async (t) => {
  const { DB, RUN_ARTIFACTS } = await createTestBindings(t);
  const { runId } = await admitTrigger(DB, request);
  const producer = crypto.randomUUID();
  await registerDiagnosticProducer(DB, runId, producer);
  const input = batch(producer);
  await ingestDiagnostics(DB, RUN_ARTIFACTS, runId, producer, input, [
    "opaque-value",
  ]);
  const bytes = await DB.prepare(
    "SELECT body_bytes FROM diagnostic_traces WHERE id = ?",
  )
    .bind(runTraceId(runId))
    .first("body_bytes");
  await ingestDiagnostics(DB, RUN_ARTIFACTS, runId, producer, input, [
    "opaque-value",
  ]);
  expect(
    await DB.prepare("SELECT body_bytes FROM diagnostic_traces WHERE id = ?")
      .bind(runTraceId(runId))
      .first("body_bytes"),
  ).toBe(bytes);
  const reader = diagnosticReader(DB, RUN_ARTIFACTS);
  const response = await reader.body("owner", input.batchId);
  assert(response);
  const content = await response.text();
  expect(content).toContain("日本語");
  expect(content).not.toContain("ghp_");
  expect(content).not.toContain("opaque-value");
  expect(await reader.body("other-owner", input.batchId)).toBeNull();
  expect(await reader.events("other-owner", runTraceId(runId), 0)).toBeNull();
  expect((await reader.traces("other-owner", {})).traces).toEqual([]);
  const first = await reader.events("owner", runTraceId(runId), 0);
  assert(first);
  const final: DiagnosticBatch = {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId: producer,
    records: [],
    completed: { lastSeq: 1, dropped: 0 },
  };
  await ingestDiagnostics(DB, RUN_ARTIFACTS, runId, producer, final);
  expect(
    await DB.prepare("SELECT capture_state FROM diagnostic_traces WHERE id = ?")
      .bind(runTraceId(runId))
      .first("capture_state"),
  ).toBe("complete");
  const conflicting = {
    ...input,
    batchId: crypto.randomUUID(),
    records: input.records.map((record) => ({ ...record, body: "different" })),
  };
  await expect(
    ingestDiagnostics(DB, RUN_ARTIFACTS, runId, producer, conflicting),
  ).rejects.toThrow();
  const late = {
    ...input,
    batchId: crypto.randomUUID(),
    records: input.records.map((record) => ({
      ...record,
      eventId: crypto.randomUUID(),
      seq: 2,
    })),
  };
  await expect(
    ingestDiagnostics(DB, RUN_ARTIFACTS, runId, producer, late),
  ).rejects.toThrow("closed");
  await DB.prepare(
    "UPDATE diagnostic_artifacts SET expires_at = ? WHERE id = ?",
  )
    .bind(Date.now() - 1, input.batchId)
    .run();
  expect((await reader.body("owner", input.batchId))?.status).toBe(410);
  await expireDiagnostics(DB, RUN_ARTIFACTS);
  expect((await reader.body("owner", input.batchId))?.status).toBe(410);
});

test("does not ACK partial storage and preserves late records in cursor order", async (t) => {
  const { DB, RUN_ARTIFACTS } = await createTestBindings(t);
  const { runId } = await admitTrigger(DB, request);
  const producer = crypto.randomUUID();
  await registerDiagnosticProducer(DB, runId, producer);
  const input = batch(producer);
  await expect(
    ingestDiagnostics(
      DB,
      {
        get: RUN_ARTIFACTS.get.bind(RUN_ARTIFACTS),
        async put() {
          throw new Error("R2 offline");
        },
      },
      runId,
      producer,
      input,
    ),
  ).rejects.toThrow();
  expect(
    await DB.prepare(
      "SELECT count(*) AS count FROM diagnostic_artifacts",
    ).first("count"),
  ).toBe(0);
  await DB.prepare(`CREATE TRIGGER reject_detail BEFORE INSERT ON diagnostic_events WHEN NEW.producer_seq IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'test D1 offline'); END`).run();
  await expect(
    ingestDiagnostics(DB, RUN_ARTIFACTS, runId, producer, input),
  ).rejects.toThrow();
  expect(
    await DB.prepare(
      "SELECT count(*) AS count FROM diagnostic_artifacts",
    ).first("count"),
  ).toBe(0);
  await DB.prepare("DROP TRIGGER reject_detail").run();
  const reader = diagnosticReader(DB, RUN_ARTIFACTS);
  const before = await reader.events("owner", runTraceId(runId), 0);
  assert(before);
  const end: DiagnosticBatch = {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId: producer,
    records: [],
    completed: { lastSeq: 1, dropped: 0 },
  };
  await ingestDiagnostics(DB, RUN_ARTIFACTS, runId, producer, end);
  expect(
    await DB.prepare("SELECT capture_state FROM diagnostic_traces WHERE id = ?")
      .bind(runTraceId(runId))
      .first("capture_state"),
  ).toBe("partial");
  input.records[0]!.at = 1;
  await ingestDiagnostics(DB, RUN_ARTIFACTS, runId, producer, input);
  const after = await reader.events(
    "owner",
    runTraceId(runId),
    before.nextCursor,
  );
  expect(after?.events.map((event) => event.eventId)).toEqual([
    input.records[0]!.eventId,
  ]);
  expect(
    await DB.prepare("SELECT capture_state FROM diagnostic_traces WHERE id = ?")
      .bind(runTraceId(runId))
      .first("capture_state"),
  ).toBe("complete");
});

test("recovers runs admitted by an older Worker during rollout", async (t) => {
  const db = await createTestDb(t);
  const run = await admitTrigger(db, request);
  await db.prepare("DELETE FROM diagnostic_traces").run();
  expect(await admitTrigger(db, request)).toEqual(run);
  expect(
    await db
      .prepare(
        "SELECT name FROM diagnostic_events WHERE trace_id = ? AND name = 'run.snapshot'",
      )
      .bind(runTraceId(run.runId))
      .first("name"),
  ).toBe("run.snapshot");
  await db.prepare("DELETE FROM diagnostic_traces").run();
  await advanceRun(db, run.runId, {
    async start() {
      return { status: "succeeded", reply: "done", events: [] };
    },
    async poll() {
      throw new Error("Unexpected poll");
    },
  });
  const events = await db
    .prepare(
      "SELECT name FROM diagnostic_events WHERE trace_id = ? ORDER BY ingest_seq",
    )
    .bind(runTraceId(run.runId))
    .all();
  expect(events.results.map((event) => event.name)).toEqual([
    "run.snapshot",
    "run.started",
    "run.finished",
  ]);
});

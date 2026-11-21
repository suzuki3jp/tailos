import { assert, expect, test, vi } from "vitest";
import type {
  DiagnosticBatch,
  DiagnosticRecord,
} from "@tailos/core/diagnostics";
import { parseTimelineSnapshot } from "@tailos/core/timeline";
import app from "@/bootstrap/http.ts";
import { createTestBindings } from "./testing.ts";
import { admitTrigger } from "./trigger-admission.ts";
import {
  d1Timeline,
  expireTimeline,
  readTimelineSnapshot,
} from "./timeline.ts";
import {
  ingestDiagnostics,
  registerDiagnosticProducer,
} from "@/infrastructure/diagnostics/store.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { deliverTimelineNotifications } from "@/infrastructure/cloudflare/session-stream.ts";
import { d1Sessions } from "./sessions.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const request = {
  source: "test",
  idempotencyKey: "timeline",
  ownerId: "owner",
  concurrencyKey: "timeline",
  prompt: "test",
  executionContext: '{"version":1,"engine":"fake"}',
  timeoutMs: 60_000,
};
function record(
  seq: number,
  overrides: Partial<DiagnosticRecord> = {},
): DiagnosticRecord {
  return {
    eventId: crypto.randomUUID(),
    spanId: "command",
    seq,
    at: Date.now(),
    name: "span.started",
    attributes: { operation: "command" },
    ...overrides,
  };
}

test("projects sanitized records atomically, deduplicates retry, and keeps a completed item completed when its start arrives late", async (t) => {
  const { DB, RUN_ARTIFACTS } = await createTestBindings(t);
  const run = await admitTrigger(DB, request);
  const producerId = crypto.randomUUID();
  await registerDiagnosticProducer(DB, run.runId, producerId);
  const reader = d1Timeline(DB, RUN_ARTIFACTS);
  const finish = record(2, {
    name: "span.finished",
    attributes: {
      operation: "command",
      outcome: "succeeded",
      exitCode: 0,
      durationMs: 12,
    },
    body: JSON.stringify({ output: "42 passed" }),
  });
  const batch: DiagnosticBatch = {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId,
    records: [finish],
  };
  await ingestDiagnostics(DB, RUN_ARTIFACTS, run.runId, producerId, batch);
  const first = await reader.snapshot(run.sessionId);
  await ingestDiagnostics(DB, RUN_ARTIFACTS, run.runId, producerId, batch);
  expect((await reader.snapshot(run.sessionId)).cursor).toBe(first.cursor);
  const secret = `ghp_${"a".repeat(36)}`;
  await ingestDiagnostics(DB, RUN_ARTIFACTS, run.runId, producerId, {
    ...batch,
    batchId: crypto.randomUUID(),
    records: [
      record(1, {
        at: finish.at - 12,
        body: JSON.stringify({ command: `echo ${secret}` }),
      }),
    ],
    completed: { lastSeq: 2, dropped: 0 },
  });
  const snapshot = await reader.snapshot(run.sessionId);
  expect(snapshot.items).toHaveLength(1);
  const item = snapshot.items[0];
  expect(item.status).toBe("succeeded");
  expect(item.revision).toBe(2);
  expect(item.startedAt).toBe(finish.at - 12);
  expect(JSON.stringify(snapshot)).not.toContain(secret);
  expect(snapshot.captures[0].state).toBe("complete");
  expect((await d1Sessions(DB).read(run.sessionId, "owner"))?.timeline).toEqual(
    snapshot,
  );
  const changes = await reader.changes(run.sessionId, first.cursor);
  expect(changes?.items[0].status).toBe("succeeded");
  expect(changes?.captureChanged).toBe(true);
  expect(
    await reader.changes(run.sessionId, Number.MAX_SAFE_INTEGER),
  ).toBeNull();
  const output = await reader.output(run.sessionId, item.id);
  expect(output?.output).toContain("42 passed");
  expect(output?.input).not.toContain(secret);
  expect(await reader.output("another-session", item.id)).toBeNull();
});

test("migration exposes existing command metadata and original artifact references without inventing progress messages", async (t) => {
  let sessionId = "";
  let runId = "";
  const artifactId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const { DB, RUN_ARTIFACTS } = await createTestBindings(t, {
    async beforeMigration(db, file) {
      if (file !== "0012_session_activity.sql") return;
      const run = await admitTrigger(db, request);
      sessionId = run.sessionId;
      runId = run.runId;
      await db
        .prepare(`INSERT INTO diagnostic_artifacts (id, trace_id, span_id, object_key, digest, bytes, expires_at)
        VALUES (?, ?, 'command', 'legacy-output', 'digest', 1, ?)`)
        .bind(artifactId, `run/${runId}`, Date.now() + 60_000)
        .run();
      await db
        .prepare(`INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, producer_seq, occurred_at, received_at, name, attributes, artifact_id)
        VALUES (?, ?, 'command', 'legacy', 1, ?, ?, 'span.finished', ?, ?)`)
        .bind(
          eventId,
          `run/${runId}`,
          Date.now(),
          Date.now(),
          JSON.stringify({
            operation: "command",
            outcome: "succeeded",
            exitCode: 0,
          }),
          artifactId,
        )
        .run();
    },
  });
  await RUN_ARTIFACTS.put(
    "legacy-output",
    JSON.stringify({
      version: 1,
      batchId: artifactId,
      producerId: crypto.randomUUID(),
      records: [
        record(1, {
          eventId,
          name: "span.finished",
          body: '{"output":"legacy output"}',
        }),
      ],
    }),
  );
  const reader = d1Timeline(DB, RUN_ARTIFACTS);
  const snapshot = await reader.snapshot(sessionId);
  expect(snapshot.items).toHaveLength(1);
  expect(snapshot.items[0]).toMatchObject({
    kind: "command",
    status: "succeeded",
    hasOutput: true,
    label: null,
  });
  expect(
    (await reader.output(sessionId, `${runId}/command`))?.output,
  ).toContain("legacy output");
});

test("only commentary becomes a progress item and missing/expired output remains explicit", async (t) => {
  const { DB, RUN_ARTIFACTS } = await createTestBindings(t);
  const run = await admitTrigger(DB, request);
  const producerId = crypto.randomUUID();
  await registerDiagnosticProducer(DB, run.runId, producerId);
  const records = ["commentary", "final_answer", "unknown"] as const;
  await ingestDiagnostics(DB, RUN_ARTIFACTS, run.runId, producerId, {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId,
    records: records.map((phase, index) =>
      record(index + 1, {
        spanId: phase,
        name: "span.finished",
        attributes: {
          operation: "reply",
          outcome: "succeeded",
          messagePhase: phase,
        },
        body: JSON.stringify({
          text: phase === "commentary" ? "Checking tests" : '{"reply":"final"}',
        }),
      }),
    ),
    completed: { lastSeq: 3, dropped: 1 },
  });
  const reader = d1Timeline(DB, RUN_ARTIFACTS);
  const first = await reader.snapshot(run.sessionId);
  expect(first.items.map((item) => item.text)).toEqual(["Checking tests"]);
  expect(first.captures[0]).toMatchObject({ state: "partial", dropped: 1 });
  await DB.prepare("UPDATE session_activity_items SET body_expires_at = ?")
    .bind(Date.now() - 1)
    .run();
  expect((await reader.snapshot(run.sessionId)).items[0].text).toBeNull();
  expect(await reader.output(run.sessionId, first.items[0].id)).toEqual({
    input: null,
    output: null,
    expired: true,
  });
  await expireTimeline(DB);
  expect(
    await DB.prepare("SELECT text FROM session_activity_items").first("text"),
  ).toBeNull();
});

test("HTTP protects timeline, output and upgrades with owner, project, session cookie and Origin checks", async (t) => {
  const { DB, RUN_ARTIFACTS } = await createTestBindings(t);
  const env = { ...testLoginBindings(DB), RUN_ARTIFACTS };
  const operator = await createTestOperator(env);
  const run = await admitTrigger(DB, {
    ...request,
    ownerId: operator.id,
    projectId: "project",
  });
  const producerId = crypto.randomUUID();
  await registerDiagnosticProducer(DB, run.runId, producerId);
  await ingestDiagnostics(DB, RUN_ARTIFACTS, run.runId, producerId, {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId,
    records: [record(1, { body: '{"command":"pnpm test"}' })],
  });
  const url = `${env.TAILOS_PUBLIC_ORIGIN}/v1/projects/project/sessions/${run.sessionId}`;
  const send = (path: string, headers: Record<string, string> = {}) =>
    app.request(
      url + path,
      { headers: { Cookie: operator.cookie, ...headers } },
      env,
    );
  const response = await send("/timeline");
  expect(response.status).toBe(200);
  const snapshot = parseTimelineSnapshot(await response.json());
  expect(snapshot.items[0].label).toBe("pnpm test");
  expect((await send("/timeline", { Cookie: "" })).status).toBe(401);
  await DB.prepare("UPDATE sessions SET owner_id = 'other-owner' WHERE id = ?")
    .bind(run.sessionId)
    .run();
  expect((await send("/timeline")).status).toBe(404);
  await DB.prepare("UPDATE sessions SET owner_id = ? WHERE id = ?")
    .bind(operator.id, run.sessionId)
    .run();
  expect(
    (
      await app.request(
        url.replace("/project/", "/other/") + "/timeline",
        { headers: { Cookie: operator.cookie } },
        env,
      )
    ).status,
  ).toBe(404);
  expect((await send("/timeline?before=1&before=2")).status).toBe(400);
  expect((await send("/events?after=-1")).status).toBe(400);
  expect((await send("/events?after=999999")).status).toBe(409);
  expect(
    (
      await send("/stream", {
        Upgrade: "websocket",
        Origin: "https://attacker.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (await send("/stream", { Origin: env.TAILOS_WEB_ORIGIN })).status,
  ).toBe(426);
  expect(
    (await send(`/items/${encodeURIComponent(snapshot.items[0].id)}/output`))
      .status,
  ).toBe(200);
  await DB.prepare("UPDATE session_activity_items SET body_expires_at = ?")
    .bind(Date.now() - 1)
    .run();
  expect(
    (await send(`/items/${encodeURIComponent(snapshot.items[0].id)}/output`))
      .status,
  ).toBe(410);
});

test("failed fan-out leaves a durable outbox and retry acknowledges only the delivered version", async (t) => {
  const { DB, RUN_ARTIFACTS } = await createTestBindings(t);
  const run = await admitTrigger(DB, request);
  const producerId = crypto.randomUUID();
  await registerDiagnosticProducer(DB, run.runId, producerId);
  await ingestDiagnostics(DB, RUN_ARTIFACTS, run.runId, producerId, {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId,
    records: [record(1)],
  });
  const notify = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue(undefined);
  const env = {
    DB,
    SESSION_STREAM: {
      getByName: () => ({ notify, fetch: async () => new Response() }),
    },
  };
  await deliverTimelineNotifications(env);
  const pending = await DB.prepare(
    "SELECT version, delivered_version AS delivered FROM session_activity_notifications",
  ).first<{ version: number; delivered: number }>();
  assert(pending);
  expect(pending.version).toBeGreaterThan(pending.delivered);
  await deliverTimelineNotifications(env);
  expect(
    await DB.prepare(
      "SELECT delivered_version FROM session_activity_notifications",
    ).first("delivered_version"),
  ).toBe(pending.version);
  expect(notify).toHaveBeenCalledTimes(2);
});

test("snapshot pagination is independent of JSON aggregate element order", () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: String(index + 1),
    runId: "run",
    kind: "stage",
    label: "agent",
    text: null,
    status: "succeeded",
    startedAt: index + 1,
    finishedAt: index + 2,
    durationMs: 1,
    exitCode: null,
    revision: 1,
    bodyExpiresAt: 9999999999999,
    hasInput: false,
    hasOutput: false,
    firstCursor: index + 1,
  }));
  const snapshot = readTimelineSnapshot({
    items: JSON.stringify(rows),
    cursor: 101,
    captures: "[]",
  });
  expect(snapshot.items).toHaveLength(100);
  expect(snapshot.items[0].id).toBe("2");
  expect(snapshot.items.at(-1)?.id).toBe("101");
  expect(snapshot.before).toBe(2);
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestBindings } from "./db/testing.ts";
import app from "./index.ts";
import { smokeOwnerId } from "./internal.ts";
import { executeRun } from "./run-execution.ts";
import { admitTrigger } from "./trigger-admission.ts";

const trigger = {
  source: "test",
  idempotencyKey: "delivery",
  ownerId: smokeOwnerId,
  concurrencyKey: "issue",
  prompt: "private-prompt",
  executionContext: '{"version":1,"engine":"fake"}',
  timeoutMs: 60_000,
};

test("authorizes a run's R2 events and result and excludes chat content", async (t) => {
  const env = {
    ...(await createTestBindings(t)),
    MEGURI_TEST_TOKEN: "local-smoke",
  };
  const { runId } = await admitTrigger(env.DB, trigger);
  const failed = await admitTrigger(env.DB, {
    ...trigger,
    idempotencyKey: "failure",
    concurrencyKey: "another-issue",
  });
  const outside = await admitTrigger(env.DB, {
    ...trigger,
    idempotencyKey: "outside",
    ownerId: "another-owner",
  });
  const jobStarted = { type: "job_started", at: Date.now() } as const;
  for (const id of [runId, outside.runId]) {
    await executeRun(
      env.DB,
      id,
      async () => ({
        status: "succeeded",
        reply: "private-reply",
        events: [jobStarted, { type: "job_succeeded", at: Date.now() }],
      }),
      env.RUN_ARTIFACTS,
    );
  }
  await executeRun(
    env.DB,
    failed.runId,
    async () => ({
      status: "failed",
      errorCode: "agent_failed",
      events: [jobStarted, { type: "job_failed", at: Date.now() }],
    }),
    env.RUN_ARTIFACTS,
  );

  const path = (id: string, file: string) =>
    `/_internal/runs/${id}/artifacts/${file}`;
  const headers = { Authorization: "Bearer local-smoke" };
  assert.equal(
    (await app.request(path(runId, "result.json"), undefined, env)).status,
    401,
  );
  assert.equal(
    (await app.request(path(outside.runId, "result.json"), { headers }, env))
      .status,
    404,
  );
  assert.equal(
    (await app.request(path(runId, "execution.json"), { headers }, env)).status,
    404,
  );

  const events = await app.request(
    path(runId, "events.ndjson"),
    { headers },
    env,
  );
  assert.equal(events.status, 200);
  assert.equal(events.headers.get("Cache-Control"), "private, no-store");
  const log = await events.text();
  assert.match(log, /job_succeeded/);
  assert.doesNotMatch(log, /private-/);

  for (const [id, expected] of [
    [runId, { status: "succeeded" }],
    [failed.runId, { status: "failed", errorCode: "agent_failed" }],
  ] as const) {
    const result = await app.request(path(id, "result.json"), { headers }, env);
    assert.equal(result.status, 200);
    const body = await result.text();
    assert.doesNotMatch(body, /private-/);
    assert.deepEqual(JSON.parse(body).result, expected);
  }
});

test("an unreadable artifact returns a fixed error without exposing its contents", async (t) => {
  const env = {
    ...(await createTestBindings(t)),
    MEGURI_TEST_TOKEN: "local-smoke",
  };
  const { runId } = await admitTrigger(env.DB, trigger);
  await executeRun(
    env.DB,
    runId,
    async () => ({
      status: "succeeded",
      reply: "done",
      events: [],
    }),
    env.RUN_ARTIFACTS,
  );
  await env.RUN_ARTIFACTS.put(
    `meguri-api/v1/runs/${runId}/execution.json`,
    "sensitive invalid json",
  );

  const response = await app.request(
    `/_internal/runs/${runId}/artifacts/result.json`,
    {
      headers: { Authorization: "Bearer local-smoke" },
    },
    env,
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "artifact_unreadable" });
});

test("the public artifact result reflects D1 if persisting the agent reply fails", async (t) => {
  const env = {
    ...(await createTestBindings(t)),
    MEGURI_TEST_TOKEN: "local-smoke",
  };
  const { runId } = await admitTrigger(env.DB, trigger);
  await env.DB.prepare(`CREATE TRIGGER reject_artifact_reply BEFORE INSERT ON session_messages
    WHEN NEW.author_kind = 'agent' BEGIN SELECT RAISE(ABORT, 'test failure'); END`).run();
  await executeRun(
    env.DB,
    runId,
    async () => ({
      status: "succeeded",
      reply: "done",
      events: [],
    }),
    env.RUN_ARTIFACTS,
  );

  const response = await app.request(
    `/_internal/runs/${runId}/artifacts/result.json`,
    {
      headers: { Authorization: "Bearer local-smoke" },
    },
    env,
  );
  assert.equal(response.status, 200);
  const artifact = JSON.parse(await response.text());
  assert.deepEqual(artifact.result, {
    status: "failed",
    errorCode: "persistence_failed",
  });
});

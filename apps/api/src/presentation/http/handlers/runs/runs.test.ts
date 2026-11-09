import { assert, expect, test } from "vitest";
import { createTestBindings } from "../../../../infrastructure/d1/testing.ts";
import app from "../../../../bootstrap/http.ts";
import { smokeOwnerId } from "../../middlewares/smoke-auth.ts";
import { advanceRun } from "../../../../infrastructure/d1/run-execution.ts";
import { admitTrigger } from "../../../../infrastructure/d1/trigger-admission.ts";

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
    await advanceRun(
      env.DB,
      id,
      {
        start: async () => ({
          status: "succeeded",
          reply: "private-reply",
          events: [jobStarted, { type: "job_succeeded", at: Date.now() }],
        }),
        poll: async () => {
          throw new Error("Unexpected poll");
        },
      },
      env.RUN_ARTIFACTS,
    );
  }
  await advanceRun(
    env.DB,
    failed.runId,
    {
      start: async () => ({
        status: "failed",
        errorCode: "agent_failed",
        events: [jobStarted, { type: "job_failed", at: Date.now() }],
      }),
      poll: async () => {
        throw new Error("Unexpected poll");
      },
    },
    env.RUN_ARTIFACTS,
  );

  const path = (id: string, file: string) =>
    `/_internal/runs/${id}/artifacts/${file}`;
  const headers = { Authorization: "Bearer local-smoke" };
  expect(
    (await app.request(path(runId, "result.json"), undefined, env)).status,
  ).toBe(401);
  expect(
    (await app.request(path(outside.runId, "result.json"), { headers }, env))
      .status,
  ).toBe(404);
  expect(
    (await app.request(path(runId, "execution.json"), { headers }, env)).status,
  ).toBe(404);

  const events = await app.request(
    path(runId, "events.ndjson"),
    { headers },
    env,
  );
  expect(events.status).toBe(200);
  expect(events.headers.get("Cache-Control")).toBe("private, no-store");
  const log = await events.text();
  expect(log).toMatch(/job_succeeded/);
  expect(log).not.toMatch(/private-/);

  for (const [id, expected] of [
    [runId, { status: "succeeded" }],
    [failed.runId, { status: "failed", errorCode: "agent_failed" }],
  ] as const) {
    const result = await app.request(path(id, "result.json"), { headers }, env);
    assert(result.status === 200);
    const body = await result.text();
    expect(body).not.toMatch(/private-/);
    expect(JSON.parse(body).result).toStrictEqual(expected);
  }
});

test("an unreadable artifact returns a fixed error without exposing its contents", async (t) => {
  const env = {
    ...(await createTestBindings(t)),
    MEGURI_TEST_TOKEN: "local-smoke",
  };
  const { runId } = await admitTrigger(env.DB, trigger);
  await advanceRun(
    env.DB,
    runId,
    {
      start: async () => ({ status: "succeeded", reply: "done", events: [] }),
      poll: async () => {
        throw new Error("Unexpected poll");
      },
    },
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
  expect(response.status).toBe(502);
  expect(await response.json()).toStrictEqual({ error: "artifact_unreadable" });
});

test("the public artifact result reflects D1 if persisting the agent reply fails", async (t) => {
  const env = {
    ...(await createTestBindings(t)),
    MEGURI_TEST_TOKEN: "local-smoke",
  };
  const { runId } = await admitTrigger(env.DB, trigger);
  await env.DB.prepare(`CREATE TRIGGER reject_artifact_reply BEFORE INSERT ON session_messages
    WHEN NEW.author_kind = 'agent' BEGIN SELECT RAISE(ABORT, 'test failure'); END`).run();
  await advanceRun(
    env.DB,
    runId,
    {
      start: async () => ({ status: "succeeded", reply: "done", events: [] }),
      poll: async () => {
        throw new Error("Unexpected poll");
      },
    },
    env.RUN_ARTIFACTS,
  );

  const response = await app.request(
    `/_internal/runs/${runId}/artifacts/result.json`,
    {
      headers: { Authorization: "Bearer local-smoke" },
    },
    env,
  );
  expect(response.status).toBe(200);
  const artifact = JSON.parse(await response.text());
  expect(artifact.result).toStrictEqual({
    status: "failed",
    errorCode: "persistence_failed",
  });
});

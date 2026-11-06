import { executionContextSchema } from "@meguri/core/runner";
import { parse } from "valibot";
import { createTestOperator, testLoginBindings } from "./auth/testing.ts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestDb } from "./db/testing.ts";
import app from "./index.ts";

test("concurrent events coalesce, while redelivery stays bound after completion", async (t) => {
  const db = await createTestDb(t);
  const token = "local-test-credential";
  const env = { DB: db, MEGURI_TEST_TOKEN: token };
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const send = async (deliveryId: string, target = "issue-1") => {
    const response = await app.request(
      "/_internal/triggers",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          deliveryId,
          target,
          prompt: "Implement the request",
        }),
      },
      env,
    );
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      sessionId: string;
      runId: string;
      disposition: string;
    }>;
  };

  const [first, second, duplicate] = await Promise.all([
    send("one"),
    send("two"),
    send("one"),
  ]);
  assert.equal(first.runId, second.runId);
  assert.equal(first.sessionId, second.sessionId);
  assert.deepEqual(duplicate, first);
  assert.deepEqual([first.disposition, second.disposition].sort(), [
    "coalesced",
    "started",
  ]);

  const counts = await db
    .prepare(`SELECT
    (SELECT count(*) FROM sessions) AS sessions,
    (SELECT count(*) FROM session_messages) AS messages,
    (SELECT count(*) FROM runs) AS runs,
    (SELECT count(*) FROM trigger_events) AS events`)
    .first();
  assert.deepEqual(counts, { sessions: 1, messages: 1, runs: 1, events: 2 });
  const detail = await app.request(
    `/_internal/sessions/${first.sessionId}`,
    { headers },
    env,
  );
  assert.equal(detail.status, 200);
  const data = await detail.json();
  assert.ok(data && typeof data === "object" && "messages" in data);
  const { messages } = data;
  assert.ok(Array.isArray(messages));
  assert.equal(messages[0].body, "Implement the request");

  await db
    .prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?")
    .bind(first.runId)
    .run();
  assert.deepEqual(await send("one"), first);
  const next = await send("three");
  assert.notEqual(next.runId, first.runId);
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(next.disposition, "started");
  assert.deepEqual(await send("two", "changed-target"), second);
});

test("Codex smoke triggers require an operator and select that user's connection", async (t) => {
  const DB = await createTestDb(t);
  const env = { ...testLoginBindings(DB), MEGURI_TEST_TOKEN: "test-token" };
  const send = (bindings: { DB: typeof DB; MEGURI_TEST_TOKEN: string } = env) =>
    app.request(
      "/_internal/triggers",
      {
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
        body: JSON.stringify({
          deliveryId: "codex-delivery",
          target: "test-target",
          engine: "codex",
          prompt: "Implement the request",
        }),
      },
      bindings,
    );

  const unconfigured = await send({
    DB,
    MEGURI_TEST_TOKEN: env.MEGURI_TEST_TOKEN,
  });
  assert.equal(unconfigured.status, 503);
  const denied = await send();
  assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), { error: "operator_not_initialized" });
  assert.equal(
    await DB.prepare("SELECT count(*) AS n FROM runs").first("n"),
    0,
  );

  const operator = await createTestOperator(env);
  const accepted = await send();
  assert.equal(accepted.status, 200);
  const context = await DB.prepare(
    "SELECT execution_context FROM runs",
  ).first<string>("execution_context");
  assert.ok(context);
  assert.deepEqual(parse(executionContextSchema, JSON.parse(context)), {
    version: 1,
    engine: "codex",
    connectionId: `codex/${operator.id}`,
  });
});

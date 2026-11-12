import { ExecutionContext } from "@tailos/core/runner";
import { parse } from "valibot";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { assert, expect, test, vi } from "vitest";
import { createTriggerRoutes } from "@/presentation/http/handlers/triggers/triggers.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import app from "@/bootstrap/http.ts";

test("concurrent events coalesce, while redelivery stays bound after completion", async (t) => {
  const db = await createTestDb(t);
  const token = "local-test-credential";
  const env = { DB: db, TAILOS_TEST_TOKEN: token };
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
    expect(response.status).toBe(200);
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
  expect(first.runId).toBe(second.runId);
  expect(first.sessionId).toBe(second.sessionId);
  expect(duplicate).toStrictEqual(first);
  expect([first.disposition, second.disposition].sort()).toStrictEqual([
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
  expect(counts).toStrictEqual({
    sessions: 1,
    messages: 1,
    runs: 1,
    events: 2,
  });
  const detail = await app.request(
    `/_internal/sessions/${first.sessionId}`,
    { headers },
    env,
  );
  expect(detail.status).toBe(200);
  const data = await detail.json();
  assert(data && typeof data === "object" && "messages" in data);
  const { messages } = data;
  assert(Array.isArray(messages));
  expect(messages[0].body).toBe("Implement the request");

  await db
    .prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?")
    .bind(first.runId)
    .run();
  expect(await send("one")).toStrictEqual(first);
  const next = await send("three");
  expect(next.runId).not.toBe(first.runId);
  expect(next.sessionId).not.toBe(first.sessionId);
  expect(next.disposition).toBe("started");
  expect(await send("two", "changed-target")).toStrictEqual(second);
});

test("Codex smoke triggers require an operator and select that user's connection", async (t) => {
  const DB = await createTestDb(t);
  const env = { ...testLoginBindings(DB), TAILOS_TEST_TOKEN: "test-token" };
  const send = (
    bindings: { DB: typeof DB; TAILOS_TEST_TOKEN: string } = env,
    engine = "codex",
  ) =>
    app.request(
      "/_internal/triggers",
      {
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
        body: JSON.stringify({
          deliveryId: `${engine}-delivery`,
          target: "test-target",
          engine,
          prompt: "Implement the request",
        }),
      },
      bindings,
    );

  const unconfigured = await send({
    DB,
    TAILOS_TEST_TOKEN: env.TAILOS_TEST_TOKEN,
  });
  expect(unconfigured.status).toBe(503);
  const denied = await send();
  expect(denied.status).toBe(503);
  expect(await denied.json()).toStrictEqual({
    error: "operator_not_initialized",
  });
  expect(await DB.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(0);

  const fake = await send(env, "fake");
  expect(fake.status).toBe(200);
  const fakeAdmission = await fake.json();
  const operator = await createTestOperator(env);
  const accepted = await send();
  expect(accepted.status).toBe(200);
  const codexAdmission = await accepted.json();
  assert(
    codexAdmission &&
      typeof codexAdmission === "object" &&
      "runId" in codexAdmission,
  );
  expect(codexAdmission).not.toStrictEqual(fakeAdmission);
  expect(codexAdmission).toMatchObject({ disposition: "started" });
  const context = await DB.prepare(
    "SELECT execution_context FROM runs WHERE id = ?",
  )
    .bind(codexAdmission.runId)
    .first<string>("execution_context");
  assert(context);
  expect(parse(ExecutionContext, JSON.parse(context))).toStrictEqual({
    version: 1,
    engine: "codex",
    connectionId: `codex/${operator.id}`,
  });
});
test.each(["started", "coalesced"] as const)(
  "preserves %s admission if scheduling fails and only schedules a new Run",
  async (disposition) => {
    const schedule = vi.fn(async (_id: string) => {
      throw new Error("Alarm unavailable");
    });
    const admission = { sessionId: "session", runId: "run", disposition };
    const routes = createTriggerRoutes(
      () => schedule,
      () => async () => admission,
      async () => null,
    );
    const response = await routes.request(
      "/",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deliveryId: "delivery",
          target: "target",
          prompt: "Work",
        }),
      },
      { TAILOS_TEST_TOKEN: "test-token" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual(admission);
    expect(schedule).toHaveBeenCalledTimes(disposition === "started" ? 1 : 0);
    if (disposition === "started") expect(schedule).toHaveBeenCalledWith("run");
  },
);

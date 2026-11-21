import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assert, expect, test } from "vitest";
import { createTestBindings } from "@/infrastructure/d1/testing.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { d1Timeline } from "@/infrastructure/d1/timeline.ts";
import {
  ingestDiagnostics,
  registerDiagnosticProducer,
} from "@/infrastructure/diagnostics/store.ts";
import { parseTimelineMessage } from "@tailos/core/timeline";

test("the authenticated HTTP router preserves WebSocket upgrades through CORS and response middleware", async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      contents: `
      export { SessionStream } from "./session-stream.ts";
      export { default } from "@/bootstrap/http.ts";`,
    },
    bundle: true,
    format: "esm",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  const values = {
    TAILOS_PUBLIC_ORIGIN: "https://api.tailos.example",
    TAILOS_WEB_ORIGIN: "https://tailos.example",
    BETTER_AUTH_SECRET: "test-only-47-characters-of-random-looking-value",
    TAILOS_GITHUB_OAUTH_CLIENT_ID: "test-client",
    TAILOS_GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    TAILOS_OPERATOR_GITHUB_ID: "123",
  };
  const { DB, worker } = await createTestBindings(t, {
    script: bundle.outputFiles[0].text,
    bindings: values,
    durableObjects: {
      SESSION_STREAM: { className: "SessionStream", useSQLite: true },
    },
  });
  const operator = await createTestOperator({ ...values, DB });
  const run = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "router-ws",
    ownerId: operator.id,
    projectId: "project",
    concurrencyKey: "router-ws",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60000,
  });
  const url = `${values.TAILOS_PUBLIC_ORIGIN}/v1/projects/project/sessions/${run.sessionId}/stream`;
  const response = await worker.dispatchFetch(url, {
    headers: {
      Upgrade: "websocket",
      Origin: values.TAILOS_WEB_ORIGIN,
      Cookie: operator.cookie,
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  assert(socket);
  socket.accept();
  const pong = new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    }),
  );
  socket.send(JSON.stringify({ type: "ping" }));
  expect(JSON.parse(await pong)).toEqual({ type: "pong" });
  socket.close();
  expect(
    (
      await worker.dispatchFetch(url, {
        headers: {
          Upgrade: "websocket",
          Origin: "https://attacker.example",
          Cookie: operator.cookie,
        },
      })
    ).status,
  ).toBe(403);
});

test("real WebSocket resumes durable changes, supports ping, and revokes a deleted login before sending more data", async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      contents: `
      export { SessionStream } from "./session-stream.ts";
      export default { async fetch(request, env) {
        const stub = env.SESSION_STREAM.getByName(request.headers.get("X-Tailos-Session"));
        if (new URL(request.url).pathname === "/notify") { await stub.notify(request.headers.get("X-Tailos-Session")); return new Response(null); }
        return stub.fetch(request);
      }};`,
    },
    bundle: true,
    format: "esm",
    external: ["cloudflare:workers"],
    write: false,
  });
  const { DB, RUN_ARTIFACTS, worker } = await createTestBindings(t, {
    script: bundle.outputFiles[0].text,
    bindings: { TAILOS_OPERATOR_GITHUB_ID: "123" },
    durableObjects: {
      SESSION_STREAM: { className: "SessionStream", useSQLite: true },
    },
  });
  const operator = await createTestOperator(testLoginBindings(DB));
  const run = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "ws",
    ownerId: operator.id,
    projectId: "project",
    concurrencyKey: "ws",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60000,
  });
  const loginId = await DB.prepare(
    "SELECT id FROM login_sessions WHERE user_id = ?",
  )
    .bind(operator.id)
    .first<string>("id");
  assert(loginId);
  const producerId = crypto.randomUUID();
  await registerDiagnosticProducer(DB, run.runId, producerId);
  const start = {
    eventId: crypto.randomUUID(),
    spanId: "command",
    seq: 1,
    at: Date.now(),
    name: "span.started" as const,
    attributes: { operation: "command" as const },
    body: '{"command":"pnpm test"}',
  };
  await ingestDiagnostics(DB, RUN_ARTIFACTS, run.runId, producerId, {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId,
    records: [start],
  });
  const snapshot = await d1Timeline(DB).snapshot(run.sessionId);
  const headers = {
    "X-Tailos-Session": run.sessionId,
    "X-Tailos-Owner": operator.id,
    "X-Tailos-Login": loginId,
    "X-Tailos-Project": "project",
  };
  const connect = async () => {
    const response = await worker.dispatchFetch("http://worker/stream", {
      headers: { ...headers, Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    assert(socket);
    socket.accept();
    return socket;
  };
  const socket = await connect();
  const frame = (target: typeof socket) =>
    new Promise<ReturnType<typeof parseTimelineMessage>>((resolve) =>
      target.addEventListener(
        "message",
        (event) =>
          resolve(parseTimelineMessage(JSON.parse(String(event.data)))),
        { once: true },
      ),
    );
  const pong = frame(socket);
  socket.send(JSON.stringify({ type: "ping" }));
  expect((await pong).type).toBe("pong");
  socket.send(JSON.stringify({ type: "resume", after: snapshot.cursor }));
  await ingestDiagnostics(DB, RUN_ARTIFACTS, run.runId, producerId, {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId,
    records: [
      {
        ...start,
        eventId: crypto.randomUUID(),
        seq: 2,
        name: "span.finished",
        attributes: { operation: "command", outcome: "succeeded", exitCode: 0 },
        body: '{"output":"42 passed"}',
      },
    ],
  });
  const changed = frame(socket);
  await worker.dispatchFetch("http://worker/notify", { headers });
  const message = await changed;
  assert(message.type === "changes");
  expect(message.items[0]).toMatchObject({
    status: "succeeded",
    label: "pnpm test",
  });
  expect(JSON.stringify(message)).not.toContain("42 passed");
  socket.close();
  const resumed = await connect();
  const replay = frame(resumed);
  resumed.send(JSON.stringify({ type: "resume", after: snapshot.cursor }));
  expect(await replay).toEqual(message);
  await DB.prepare("DELETE FROM login_sessions WHERE id = ?")
    .bind(loginId)
    .run();
  const closed = new Promise<number>((resolve) =>
    resumed.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  resumed.send(JSON.stringify({ type: "ping" }));
  expect(await closed).toBe(1008);
  expect(
    (
      await worker.dispatchFetch("http://worker/stream", {
        headers: { ...headers, Upgrade: "websocket" },
      })
    ).status,
  ).toBe(401);
});

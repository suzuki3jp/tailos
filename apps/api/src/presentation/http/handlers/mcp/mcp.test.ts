import { createHash } from "node:crypto";
import { d1McpKeys } from "@/infrastructure/d1/mcp-keys.ts";
import { assert, expect, test, vi, type TestContext } from "vitest";
import app from "@/bootstrap/http.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { createTestBindings } from "@/infrastructure/d1/testing.ts";
import { d1Sessions } from "@/infrastructure/d1/sessions.ts";
import { writeRunArtifacts } from "@/infrastructure/r2/run-artifacts.ts";
import { createMcpRoutes } from "@/presentation/http/handlers/mcp/mcp.ts";
import { inspectionStore } from "@/infrastructure/inspection.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import {
  ingestDiagnostics,
  registerDiagnosticProducer,
} from "@/infrastructure/diagnostics/store.ts";

const key = "tailos_read_" + "x".repeat(43);
const digest = createHash("sha256").update(key).digest("hex");
const target = JSON.stringify({
  version: 1,
  kind: "github.issue",
  repositoryId: 100,
  issueNumber: 12,
});

async function setup(t: TestContext) {
  const bindings = await createTestBindings(t);
  const login = testLoginBindings(bindings.DB);
  const operator = await createTestOperator(login);
  const keyId = crypto.randomUUID();
  await d1McpKeys(bindings.DB).create(operator.id, {
    id: keyId,
    name: "Test",
    prefix: key.slice(0, 20),
    sha256: digest,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const env = { ...bindings, ...login };
  const url = env.TAILOS_PUBLIC_ORIGIN + "/mcp";
  function request(
    method: string,
    params: Record<string, unknown> = {},
    legacy = false,
  ) {
    return new Request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": legacy ? "2025-11-25" : "2026-07-28",
        ...(!legacy
          ? {
              "Mcp-Method": method,
              ...(typeof params.name === "string"
                ? { "Mcp-Name": params.name }
                : {}),
            }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          ...(!legacy
            ? {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientCapabilities": {},
                  "io.modelcontextprotocol/clientInfo": {
                    name: "test",
                    version: "1",
                  },
                },
              }
            : {}),
        },
      }),
    });
  }
  async function rpc(
    method: string,
    params: Record<string, unknown> = {},
    legacy = false,
  ) {
    const response = await app.fetch(request(method, params, legacy), env);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    return JSON.parse(
      body.startsWith("event:")
        ? (body
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? "null")
        : body,
    );
  }
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await rpc("tools/call", { name, arguments: args })).result;
  async function seed(ownerId: string = operator.id, createdAt = 1000) {
    const sessionId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await d1Sessions(env.DB).create({
      id: sessionId,
      ownerId,
      createdAt,
      messages: [
        {
          id: messageId,
          sessionId,
          seq: 1,
          authorKind: "user",
          body: "a".repeat(999) + "😀日本語",
          createdAt,
        },
      ],
    });
    await env.DB.prepare(
      "UPDATE sessions SET project_id = ?, target = ? WHERE id = ?",
    )
      .bind("project", target, sessionId)
      .run();
    await env.DB.prepare(`INSERT INTO runs (id, session_id, start_message_id, status, execution_context, step_state, result, error_code, deadline_at, created_at, finished_at)
      VALUES (?, ?, ?, 'failed', ?, ?, ?, 'agent_failed', 2000, ?, 1500)`)
      .bind(
        runId,
        sessionId,
        messageId,
        '{"credential":"must-not-expose"}',
        '{"token":"must-not-expose"}',
        '{"version":1,"kind":"completed"}',
        createdAt,
      )
      .run();
    return { sessionId, messageId, runId };
  }
  return { env, operator, keyId, url, request, rpc, call, seed };
}

test("MCP requires its own unexpired, owner-bound key and validates the origin and method", async (t) => {
  const f = await setup(t);
  const send = (
    env = f.env,
    headers: Record<string, string> = {},
    method = "POST",
  ) =>
    app.request(
      f.url,
      { method, headers: { Authorization: `Bearer ${key}`, ...headers } },
      env,
    );
  expect((await send({ ...f.env, TAILOS_OPERATOR_GITHUB_ID: "" })).status).toBe(
    404,
  );
  expect(
    (
      await send(f.env, {
        Authorization: "Bearer tailos_read_" + "y".repeat(43),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await send(f.env, {
        Authorization: "Bearer wrong",
        Cookie: f.operator.cookie,
      })
    ).status,
  ).toBe(401);
  expect(
    (await send(f.env, { Authorization: "", Cookie: f.operator.cookie }))
      .status,
  ).toBe(401);
  await f.env.DB.prepare("UPDATE mcp_keys SET expires_at = ? WHERE id = ?")
    .bind(Date.now() - 1, f.keyId)
    .run();
  expect((await send()).status).toBe(401);
  await f.env.DB.prepare("UPDATE mcp_keys SET expires_at = ? WHERE id = ?")
    .bind(Date.now() + 60_000, f.keyId)
    .run();
  expect(
    (await send({ ...f.env, TAILOS_OPERATOR_GITHUB_ID: "999" })).status,
  ).toBe(401);
  expect((await send(f.env, { Origin: "https://other.example" })).status).toBe(
    403,
  );
  expect(
    (await send({ ...f.env, TAILOS_PUBLIC_ORIGIN: "https://other.example" }))
      .status,
  ).toBe(404);
  for (const method of ["GET", "DELETE"]) {
    const response = await send(f.env, {}, method);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  }
  const unauth = await send(f.env, { Authorization: "" });
  expect(unauth.headers.get("WWW-Authenticate")).toContain("Bearer");
  expect(unauth.headers.get("Cache-Control")).toBe("private, no-store");
});

test("modern and legacy MCP discover the same read-only tools and usage", async (t) => {
  const f = await setup(t);
  const modern = await f.rpc("tools/list");
  const initialized = await f.rpc(
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "legacy", version: "1" },
    },
    true,
  );
  expect(initialized.result.protocolVersion).toBe("2025-11-25");
  expect(initialized.result.instructions).toContain("get_usage");
  const legacy = await f.rpc("tools/list", {}, true);
  expect(
    modern.result.tools.map((tool: { name: string }) => tool.name),
  ).toEqual(legacy.result.tools.map((tool: { name: string }) => tool.name));
  expect(modern.result.tools).toHaveLength(11);
  for (const tool of modern.result.tools)
    expect(tool.annotations.readOnlyHint).toBe(true);
  const usage = await f.call("get_usage");
  expect(usage.structuredContent.limits.artifacts).toContain(
    "do not guarantee",
  );
  const invalid = await f.call("list_sessions", { limit: 1000 });
  expect(invalid.isError).toBe(true);
  const unsupported = await f.rpc("tools/call", {
    name: "start_run",
    arguments: { runId: crypto.randomUUID() },
  });
  expect(unsupported.result).toBeUndefined();
  expect(unsupported.error.code).toBe(-32602);
  const oversized = f.request("tools/call", {
    name: "get_usage",
    arguments: { extra: "x".repeat(33 * 1024) },
  });
  expect((await app.fetch(oversized, f.env)).status).toBe(413);
});

test("session and run investigation paginates tied timestamps without exposing other owners or internal configuration", async (t) => {
  const f = await setup(t);
  const first = await f.seed();
  const second = await f.seed();
  const outside = await f.seed("other-owner", 9000);
  const found = await f.call("list_sessions", {
    limit: 1,
    projectId: "project",
    target,
  });
  expect(found.structuredContent.items).toHaveLength(1);
  const next = await f.call("list_sessions", {
    limit: 1,
    before: found.structuredContent.nextCursor,
  });
  expect(
    new Set(
      [...found.structuredContent.items, ...next.structuredContent.items].map(
        (row) => row.id,
      ),
    ),
  ).toEqual(new Set([first.sessionId, second.sessionId]));
  expect(next.structuredContent.nextCursor).toBe(null);
  expect(
    (await f.call("list_sessions", { projectId: "missing" })).structuredContent
      .items,
  ).toEqual([]);

  const extraMessageId = crypto.randomUUID();
  await f.env.DB.prepare(
    "INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at) VALUES (?, ?, 2, 'agent', 'reply', 1500)",
  )
    .bind(extraMessageId, first.sessionId)
    .run();
  const detail = (
    await f.call("get_session", { sessionId: first.sessionId, limit: 1 })
  ).structuredContent;
  expect(Array.from(detail.messages[0].body)).toHaveLength(1000);
  expect(detail.messages[0].body.endsWith("😀")).toBe(true);
  expect(detail.messages[0].bodyLength).toBe(1003);
  expect(detail.nextAfterSeq).toBe(1);
  const continuation = (
    await f.call("get_session", {
      sessionId: first.sessionId,
      afterSeq: detail.nextAfterSeq,
    })
  ).structuredContent;
  expect(continuation.messages.map((row: { id: string }) => row.id)).toEqual([
    extraMessageId,
  ]);
  expect(continuation.nextAfterSeq).toBe(null);
  expect(
    (
      await f.call("read_message", {
        messageId: first.messageId,
        offset: 999,
        limit: 2,
      })
    ).structuredContent,
  ).toEqual({ text: "😀日", nextOffset: 1001, totalLength: 1003 });
  expect(
    (await f.call("read_message", { messageId: first.messageId, offset: 1001 }))
      .structuredContent.text,
  ).toBe("本語");

  const executions = (await f.call("list_runs", { status: "failed", limit: 1 }))
    .structuredContent;
  const older = (await f.call("list_runs", { before: executions.nextCursor }))
    .structuredContent;
  expect(
    new Set([...executions.items, ...older.items].map((row) => row.id)),
  ).toEqual(new Set([first.runId, second.runId]));
  expect(
    (
      await f.call("list_runs", { sessionId: first.sessionId })
    ).structuredContent.items.map((row: { id: string }) => row.id),
  ).toEqual([first.runId]);
  const run = await f.call("get_run", { runId: first.runId });
  expect(run.structuredContent.errorCode).toBe("agent_failed");
  expect(JSON.stringify(run)).not.toContain("must-not-expose");
  for (const [name, args] of [
    ["get_session", { sessionId: outside.sessionId }],
    ["read_message", { messageId: outside.messageId }],
    ["get_run", { runId: outside.runId }],
    ["read_run_artifact", { runId: outside.runId, file: "events.ndjson" }],
  ] as const)
    expect((await f.call(name, args)).structuredContent).toEqual({
      error: "not_found",
    });
});

test("legacy artifacts preserve missing states and D1 outcome, and R2 is never read for another owner's run", async (t) => {
  const f = await setup(t);
  const owned = await f.seed();
  const outside = await f.seed("other-owner");
  const get = vi.spyOn(f.env.RUN_ARTIFACTS, "get");
  await f.call("read_run_artifact", {
    runId: outside.runId,
    file: "result.json",
  });
  expect(get).not.toHaveBeenCalled();
  expect(
    (
      await f.call("read_run_artifact", {
        runId: owned.runId,
        file: "result.json",
      })
    ).structuredContent,
  ).toEqual({ state: "unavailable" });
  await writeRunArtifacts(
    f.env.RUN_ARTIFACTS,
    owned.runId,
    1500,
    { status: "succeeded" },
    [{ type: "job_started", at: 1000 }],
  );
  const metadata = (
    await f.call("read_run_artifact", {
      runId: owned.runId,
      file: "result.json",
    })
  ).structuredContent;
  expect(metadata.state).toBe("available");
  expect(JSON.parse(metadata.text).result).toEqual({
    status: "failed",
    errorCode: "agent_failed",
  });
  const events = (
    await f.call("read_run_artifact", {
      runId: owned.runId,
      file: "events.ndjson",
    })
  ).structuredContent;
  expect(JSON.parse(events.text)).toEqual({ type: "job_started", at: 1000 });
  await f.env.DB.prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .bind(owned.runId)
    .run();
  expect(
    (
      await f.call("read_run_artifact", {
        runId: owned.runId,
        file: "events.ndjson",
      })
    ).structuredContent.state,
  ).toBe("not_ready");
  await f.env.DB.prepare("UPDATE runs SET status = 'failed' WHERE id = ?")
    .bind(owned.runId)
    .run();
  await f.env.RUN_ARTIFACTS.put(
    `tailos-api/v1/runs/${owned.runId}/execution.json`,
    "invalid-json",
  );
  expect(
    (
      await f.call("read_run_artifact", {
        runId: owned.runId,
        file: "result.json",
      })
    ).structuredContent.state,
  ).toBe("unreadable");
});

test("diagnostics reuse Web ownership rules, cursor reads and retention while bounding artifact bodies", async (t) => {
  const f = await setup(t);
  const input = {
    source: "mcp-test",
    idempotencyKey: "delivery",
    ownerId: f.operator.id,
    concurrencyKey: "mcp-test",
    prompt: "Inspect",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  };
  const owned = await admitTrigger(f.env.DB, input);
  const outside = await admitTrigger(f.env.DB, {
    ...input,
    ownerId: "other-owner",
    concurrencyKey: "outside",
    idempotencyKey: "outside",
  });
  const traceId = `run/${owned.runId}`;
  const producerId = crypto.randomUUID();
  await registerDiagnosticProducer(f.env.DB, owned.runId, producerId);
  const batchId = crypto.randomUUID();
  await ingestDiagnostics(
    f.env.DB,
    f.env.RUN_ARTIFACTS,
    owned.runId,
    producerId,
    {
      version: 1,
      batchId,
      producerId,
      records: [
        {
          eventId: crypto.randomUUID(),
          spanId: "command/test",
          seq: 1,
          at: Date.now(),
          name: "output",
          attributes: { operation: "command" },
          body: "😀日本語".repeat(100),
        },
      ],
    },
  );
  const traces = (await f.call("list_traces", { runId: owned.runId }))
    .structuredContent;
  expect(traces.traces.map((trace: { id: string }) => trace.id)).toContain(
    traceId,
  );
  expect(
    (await f.call("list_traces", { runId: outside.runId })).structuredContent
      .traces,
  ).toEqual([]);
  const events = (await f.call("list_events", { traceId })).structuredContent;
  expect(
    events.events.some(
      (event: { artifactId: string | null }) => event.artifactId === batchId,
    ),
  ).toBe(true);
  const later = (
    await f.call("list_events", { traceId, after: events.nextCursor })
  ).structuredContent;
  expect(later.events).toEqual([]);
  expect(later.nextCursor).toBe(events.nextCursor);
  const artifacts = (await f.call("list_artifacts", { traceId }))
    .structuredContent;
  expect(
    artifacts.artifacts.map((artifact: { id: string }) => artifact.id),
  ).toContain(batchId);
  const chunk = (
    await f.call("read_diagnostic_artifact", { artifactId: batchId, limit: 31 })
  ).structuredContent;
  expect(chunk.state).toBe("available");
  expect(Array.from(chunk.text)).toHaveLength(31);
  expect(chunk.nextOffset).toBe(31);
  expect(chunk.totalLength).toBeGreaterThan(100);
  for (const tool of ["list_events", "list_artifacts"]) {
    expect(
      (await f.call(tool, { traceId: `run/${outside.runId}` }))
        .structuredContent,
    ).toEqual({ error: "not_found" });
  }
  await f.env.DB.prepare(
    "INSERT INTO diagnostic_traces (id, source, created_at, expires_at) VALUES ('request/ownerless', 'webhook', 1, ?)",
  )
    .bind(Date.now() + 60_000)
    .run();
  expect(
    (
      await f.call("list_traces", { source: "webhook" })
    ).structuredContent.traces.map((trace: { id: string }) => trace.id),
  ).toContain("request/ownerless");
  await f.env.DB.prepare(
    "UPDATE diagnostic_artifacts SET expires_at = ? WHERE id = ?",
  )
    .bind(Date.now() - 1, batchId)
    .run();
  expect(
    (await f.call("read_diagnostic_artifact", { artifactId: batchId }))
      .structuredContent.state,
  ).toBe("expired");
  await f.env.DB.prepare(
    "UPDATE diagnostic_artifacts SET expires_at = ? WHERE id = ?",
  )
    .bind(Date.now() + 60_000, batchId)
    .run();
  const objectKey = await f.env.DB.prepare(
    "SELECT object_key FROM diagnostic_artifacts WHERE id = ?",
  )
    .bind(batchId)
    .first<string>("object_key");
  assert(objectKey);
  await f.env.RUN_ARTIFACTS.put(objectKey, "corrupt");
  expect(
    (await f.call("read_diagnostic_artifact", { artifactId: batchId }))
      .structuredContent.state,
  ).toBe("unreadable");
});

test("storage exception details never enter tool output", async (t) => {
  const f = await setup(t);
  const isolated = createMcpRoutes(
    async () => ({ state: "authenticated", ownerId: f.operator.id }),
    (env) => ({
      ...inspectionStore(env),
      async listSessions() {
        throw new Error("private-storage-value");
      },
    }),
  );
  const request = f.request("tools/call", {
    name: "list_sessions",
    arguments: {},
  });
  const response = await isolated.request(
    f.env.TAILOS_PUBLIC_ORIGIN + "/",
    request,
    f.env,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("read_failed");
  expect(text).not.toContain("private-storage-value");
  assert(response.headers.get("Cache-Control"));
});

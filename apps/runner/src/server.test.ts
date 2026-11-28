import {
  ExecutionContext,
  RunnerJob as RunnerJobSchema,
} from "@tailos/core/runner";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { assert, expect, test, vi, type TestContext } from "vitest";
import {
  parseDiagnosticBatch,
  type DiagnosticRecord,
} from "@tailos/core/diagnostics";
import { RunnerStatus, type RunnerJob } from "@tailos/core/runner";
import * as v from "valibot";
import {
  AgentSandboxUnavailable,
  fakeAgent,
  type AgentAdapter,
} from "@/agent.ts";
import { claudeAgent } from "@/claude-agent.ts";
import { codexAgent } from "@/codex-agent.ts";
import { createRunnerServer } from "@/server.ts";
import { withDiagnosticSpan } from "@/diagnostic-operations.ts";

async function listen(t: TestContext, agent?: AgentAdapter) {
  const server = createRunnerServer({
    fake: agent ?? fakeAgent,
    codex: codexAgent,
    claude: claudeAgent,
  });
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

const key = "c".repeat(64);
const control = { headers: { Authorization: `Bearer ${key}` } };
const sendJob = (origin: string, job: RunnerJob, bearer = key) =>
  fetch(`${origin}/job`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(job),
  });

test("serves the internal health endpoint", async (t) => {
  const origin = await listen(t);
  const health = await fetch(`${origin}/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toStrictEqual({
    status: "ok",
    service: "runner",
  });
  expect((await fetch(`${origin}/health`, { method: "POST" })).status).toBe(
    404,
  );
  expect((await fetch(`${origin}/`)).status).toBe(404);
});

function diagnosticJob(deadlineAt: number): RunnerJob {
  const runId = randomUUID();
  return {
    version: 1,
    engine: "fake",
    runId,
    prompt: "test",
    deadlineAt,
    diagnostics: {
      traceId: `run/${runId}`,
      parentSpanId: `run/${runId}`,
      producerId: randomUUID(),
      url: "https://diag.example/diagnostics",
      bearer: "a".repeat(64),
      expiresAt: deadlineAt + 120_000,
    },
  };
}

async function terminalStatus(origin: string, runId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = v.parse(
      RunnerStatus,
      await (await fetch(`${origin}/job/${runId}`, control)).json(),
    );
    if (result.status !== "running") return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Runner did not finish within its diagnostic budget");
}

test("keeps the job running until its final diagnostic marker is delivered", async (t) => {
  const nativeFetch = globalThis.fetch;
  let markerSeen = () => {};
  const markerReady = new Promise<void>((resolve) => {
    markerSeen = resolve;
  });
  let release = () => {};
  const markerResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      if (String(input) !== "https://diag.example/diagnostics")
        return nativeFetch(input, init);
      const batch = parseDiagnosticBatch(JSON.parse(String(init?.body)));
      if (batch.completed) {
        markerSeen();
        await markerResponse;
      }
      return new Response(null, { status: 204 });
    });
  t.onTestFinished(() => {
    release();
    spy.mockRestore();
  });
  const origin = await listen(t);
  const job = diagnosticJob(Date.now() + 10_000);
  expect((await sendJob(origin, job)).status).toBe(202);
  await markerReady;
  expect(
    await (await nativeFetch(`${origin}/job/${job.runId}`, control)).json(),
  ).toEqual({ status: "running" });
  release();
  expect((await terminalStatus(origin, job.runId)).status).toBe("succeeded");
});

test("does not let an unresponsive diagnostic endpoint hold the business result past its deadline", async (t) => {
  const nativeFetch = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) =>
      String(input) === "https://diag.example/diagnostics"
        ? new Promise<Response>(() => {})
        : nativeFetch(input, init),
    );
  t.onTestFinished(() => spy.mockRestore());
  const origin = await listen(t);
  const job = diagnosticJob(Date.now() + 700);
  expect((await sendJob(origin, job)).status).toBe(202);
  expect((await terminalStatus(origin, job.runId)).status).toBe("succeeded");
});

test("executes the selected agent once and rejects a different job while it runs", async (t) => {
  let calls = 0;
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const origin = await listen(t, {
    async run(job) {
      calls++;
      if (calls === 1) await released;
      return { reply: `Received ${job.prompt}` };
    },
  });
  const job: RunnerJob = {
    version: 1,
    engine: "fake",
    runId: randomUUID(),
    prompt: "Fix the issue",
    deadlineAt: Date.now() + 60_000,
  };
  expect((await sendJob(origin, { ...job, prompt: "" })).status).toBe(400);
  expect((await sendJob(origin, job)).status).toBe(202);
  expect((await sendJob(origin, job)).status).toBe(202);
  const next = { ...job, runId: randomUUID() };
  expect((await sendJob(origin, next)).status).toBe(409);
  expect(calls).toBe(1);
  release();
  await vi.waitFor(async () => {
    const status = await fetch(`${origin}/job/${job.runId}`, control);
    expect(v.parse(RunnerStatus, await status.json()).status).toBe("succeeded");
  });
  const result = v.parse(
    RunnerStatus,
    await (await fetch(`${origin}/job/${job.runId}`, control)).json(),
  );
  assert(result.status === "succeeded");
  expect(result.reply).toBe("Received Fix the issue");
  expect(result.events.map((event) => event.type)).toStrictEqual([
    "job_started",
    "job_succeeded",
  ]);
  // A container kept for the Session takes its next Turn, from the same
  // controller only.
  expect((await sendJob(origin, next, "d".repeat(64))).status).toBe(401);
  expect((await sendJob(origin, next)).status).toBe(202);
  await vi.waitFor(() => expect(calls).toBe(2));
});

test("cancels an active adapter at the job deadline", async (t) => {
  let signal: AbortSignal | undefined;
  const origin = await listen(t, {
    async run(_job, deadline) {
      signal = deadline;
      await once(deadline, "abort");
      deadline.throwIfAborted();
      return { reply: "unexpected" };
    },
  });
  const job: RunnerJob = {
    version: 1,
    engine: "fake",
    runId: randomUUID(),
    prompt: "Wait",
    deadlineAt: Date.now() + 500,
  };
  expect((await sendJob(origin, job)).status).toBe(202);
  assert(signal);
  if (!signal.aborted) await once(signal, "abort");
  const result = v.parse(
    RunnerStatus,
    await (await fetch(`${origin}/job/${job.runId}`, control)).json(),
  );
  assert(result.status === "failed");
  expect(result.errorCode).toBe("deadline_exceeded");
  expect(result.events.map((event) => event.type)).toStrictEqual([
    "job_started",
    "job_failed",
  ]);
});

test("reports out-of-contract replies as agent failures", async (t) => {
  const origin = await listen(t, {
    async run() {
      return { reply: "" };
    },
  });
  const job: RunnerJob = {
    version: 1,
    engine: "fake",
    runId: randomUUID(),
    prompt: "Reply",
    deadlineAt: Date.now() + 60_000,
  };
  expect((await sendJob(origin, job)).status).toBe(202);
  const result = v.parse(
    RunnerStatus,
    await (await fetch(`${origin}/job/${job.runId}`, control)).json(),
  );
  assert(result.status === "failed");
  expect(result.errorCode).toBe("agent_failed");
  expect(result.events.map((event) => event.type)).toStrictEqual([
    "job_started",
    "job_failed",
  ]);
});

test("records cleanup failures with redacted system details before exposing failed status", async (t) => {
  const nativeFetch = globalThis.fetch;
  const records: DiagnosticRecord[] = [];
  const job = diagnosticJob(Date.now() + 10_000);
  const bearer = job.diagnostics!.bearer;
  const token = "ghp_" + "b".repeat(36);
  let marker: unknown;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      if (String(input) !== "https://diag.example/diagnostics")
        return nativeFetch(input, init);
      const batch = parseDiagnosticBatch(JSON.parse(String(init?.body)));
      records.push(...batch.records);
      if (batch.completed) marker = batch.completed;
      return new Response(null, { status: 204 });
    });
  t.onTestFinished(() => spy.mockRestore());
  const failure = Object.assign(
    new Error(`Cannot remove ${bearer}`, {
      cause: Object.assign(new Error(`Directory not empty ${token}`), {
        code: "ENOTEMPTY",
        errno: -39,
        syscall: "rmdir",
        path: "/tmp/tailos-test/cache",
      }),
    }),
    {
      stdout: "private subprocess output",
      env: { SECRET: "private environment" },
    },
  );
  const origin = await listen(t, {
    async run(_job, _signal, _cwd, diagnostics) {
      const agentSpan = diagnostics?.start("agent");
      if (agentSpan) diagnostics?.end(agentSpan);
      return withDiagnosticSpan(
        diagnostics,
        "cleanup",
        async () => {
          throw failure;
        },
        JSON.stringify({ target: "codex_environment" }),
      );
    },
  });
  expect((await sendJob(origin, job)).status).toBe(202);
  expect(await terminalStatus(origin, job.runId)).toMatchObject({
    status: "failed",
    errorCode: "agent_failed",
  });
  const finishes = records.filter((record) => record.name === "span.finished");
  expect(
    finishes.map((record) => [
      record.attributes.operation,
      record.attributes.outcome,
    ]),
  ).toEqual([
    ["agent", "succeeded"],
    ["cleanup", "failed"],
    ["runner", "failed"],
  ]);
  const body = JSON.parse(finishes[1]!.body!);
  expect(body.errors[0].stack).toContain("Cannot remove");
  expect(body.errors[1]).toMatchObject({
    code: "ENOTEMPTY",
    errno: -39,
    syscall: "rmdir",
    path: "/tmp/tailos-test/cache",
  });
  const saved = JSON.stringify(records);
  for (const secret of [
    bearer,
    token,
    "private subprocess output",
    "private environment",
  ])
    expect(saved).not.toContain(secret);
  expect(marker).toEqual({ lastSeq: 6, dropped: 0 });
});

test("reports a sandbox startup failure as a failed job", async (t) => {
  const origin = await listen(t, {
    async run() {
      throw new AgentSandboxUnavailable();
    },
  });
  const job: RunnerJob = {
    version: 1,
    engine: "fake",
    runId: randomUUID(),
    prompt: "Run a command",
    deadlineAt: Date.now() + 60_000,
  };
  expect((await sendJob(origin, job)).status).toBe(202);
  const response = await fetch(`${origin}/job/${job.runId}`, control);
  expect(v.parse(RunnerStatus, await response.json())).toMatchObject({
    status: "failed",
    errorCode: "sandbox_unavailable",
  });
});

test("jobs and results carry no execution mode, and stored contexts drop it", () => {
  const job = {
    version: 1,
    engine: "fake",
    runId: randomUUID(),
    prompt: "Investigate",
    deadlineAt: Date.now() + 1000,
  };
  expect(v.safeParse(RunnerJobSchema, job).success).toBe(true);
  // Every Turn runs with the same permissions: a job cannot ask for a mode.
  expect(v.safeParse(RunnerJobSchema, { ...job, mode: "plan" }).success).toBe(
    false,
  );
  expect(
    v.parse(ExecutionContext, { version: 1, engine: "fake", mode: "plan" }),
  ).toEqual({ version: 1, engine: "fake" });
  const result = {
    status: "succeeded",
    reply: "Which behavior?",
    events: [],
  };
  expect(v.safeParse(RunnerStatus, result).success).toBe(true);
  expect(
    v.safeParse(RunnerStatus, {
      ...result,
      plan: { planPresented: false, needsAnswer: true },
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(RunnerStatus, { ...result, reply: "x".repeat(8001) }).success,
  ).toBe(false);
});

test("runs a Claude job with the Claude agent and accepts only its own credentials", async (t) => {
  const run = vi.fn<AgentAdapter["run"]>(async () => ({
    reply: "from Claude",
  }));
  const server = createRunnerServer({
    fake: fakeAgent,
    codex: fakeAgent,
    claude: { run },
  });
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const job = {
    version: 1,
    engine: "claude",
    runId: randomUUID(),
    prompt: "test",
    deadlineAt: Date.now() + 10_000,
    access: { token: "claude-oauth-token", connectionVersion: randomUUID() },
  } satisfies RunnerJob;

  // A job cannot mix the Codex and Claude credential shapes.
  expect(
    v.safeParse(RunnerJobSchema, { ...job, engine: "codex" }).success,
  ).toBe(false);
  const connectionId = `claude/${randomUUID()}`;
  expect(
    v.safeParse(ExecutionContext, {
      version: 1,
      engine: "claude",
      connectionId,
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(ExecutionContext, { version: 1, engine: "codex", connectionId })
      .success,
  ).toBe(false);

  expect((await sendJob(origin, job)).status).toBe(202);
  await vi.waitFor(async () => {
    const status = await fetch(`${origin}/job/${job.runId}`, control);
    expect(await status.json()).toMatchObject({
      status: "succeeded",
      reply: "from Claude",
    });
  });
  expect(run.mock.calls[0]![0]).toEqual(job);
});

test("only the controller that sent the job can read or resend it", async (t) => {
  const origin = await listen(t);
  const job: RunnerJob = {
    version: 1,
    engine: "fake",
    runId: randomUUID(),
    prompt: "Fix the issue",
    deadlineAt: Date.now() + 60_000,
  };
  const unauthenticated = await fetch(`${origin}/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(job),
  });
  expect(unauthenticated.status).toBe(401);
  expect((await sendJob(origin, job)).status).toBe(202);
  // An Agent command does not know the key: it can neither resend nor read.
  expect((await sendJob(origin, job, "d".repeat(64))).status).toBe(401);
  expect((await fetch(`${origin}/job/${job.runId}`)).status).toBe(401);
  expect(
    (
      await fetch(`${origin}/job/${job.runId}`, {
        headers: { Authorization: `Bearer ${"d".repeat(64)}` },
      })
    ).status,
  ).toBe(401);
  expect((await fetch(`${origin}/job/${job.runId}`, control)).status).toBe(200);
  expect((await fetch(`${origin}/health`)).status).toBe(200);
});

test("takes the previous work only from the controller before the job and reports what was saved", async (t) => {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const codex: AgentAdapter = {
    run: async () => {
      await released;
      return { reply: "done" };
    },
  };
  const server = createRunnerServer({
    fake: fakeAgent,
    codex,
    claude: claudeAgent,
  });
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const other = "d".repeat(64);
  const upload = (bearer: string) =>
    fetch(`${origin}/continuity`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${bearer}` },
      body: new Uint8Array([1, 2, 3]),
    });

  expect((await upload(key)).status).toBe(204);
  // The first control request names the controller for the whole Run.
  expect((await upload(other)).status).toBe(401);
  const job: RunnerJob = {
    version: 1,
    engine: "codex",
    runId: randomUUID(),
    prompt: "test",
    deadlineAt: Date.now() + 10_000,
    continuity: { restore: "saved" },
    access: {
      accessToken: "placeholder",
      accountId: "account",
      connectionVersion: randomUUID(),
      accessVersion: randomUUID(),
    },
  };
  expect((await sendJob(origin, job, other)).status).toBe(401);
  expect((await sendJob(origin, job)).status).toBe(202);
  expect((await upload(key)).status).toBe(409);
  release();

  await vi.waitFor(async () => {
    const status = await fetch(`${origin}/job/${job.runId}`, control);
    expect(v.parse(RunnerStatus, await status.json()).status).toBe("succeeded");
  });
  const saved = `${origin}/job/${job.runId}/continuity`;
  expect(
    (await fetch(saved, { headers: { Authorization: `Bearer ${other}` } }))
      .status,
  ).toBe(401);
  // Without a work tree the Turn left nothing: the previous work stays.
  expect((await fetch(saved, control)).status).toBe(204);
});

test("has no saved work for a job that does not carry work over", async (t) => {
  const origin = await listen(t);
  const job = diagnosticJob(Date.now() + 10_000);
  delete job.diagnostics;
  expect((await sendJob(origin, job)).status).toBe(202);
  expect(
    (await fetch(`${origin}/job/${job.runId}/continuity`, control)).status,
  ).toBe(404);
});

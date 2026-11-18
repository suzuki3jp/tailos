import {
  ExecutionContext,
  RunnerJob as RunnerJobSchema,
} from "@tailos/core/runner";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { assert, expect, test, vi, type TestContext } from "vitest";
import { parseDiagnosticBatch } from "@tailos/core/diagnostics";
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

async function listen(
  t: TestContext,
  agent?: AgentAdapter,
  catalog?: Parameters<typeof createRunnerServer>[1],
) {
  const server = createRunnerServer(
    {
      fake: agent ?? fakeAgent,
      codex: codexAgent,
      claude: claudeAgent,
    },
    catalog,
  );
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

const sendJob = (origin: string, job: RunnerJob) =>
  fetch(`${origin}/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

test("model catalog validates credentials and never starts an agent job", async (t) => {
  const access = {
    accessToken: "test-access",
    accountId: "test-account",
    connectionVersion: randomUUID(),
    accessVersion: randomUUID(),
  };
  const catalog = vi.fn(async () => [
    { model: "model", efforts: ["high"], token: "private" },
  ]);
  const agent = { run: vi.fn() };
  const origin = await listen(t, agent, catalog);
  const request = (body: unknown) =>
    fetch(`${origin}/codex/models`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  expect((await request({ access: { accessToken: "invalid" } })).status).toBe(
    400,
  );
  expect(catalog).not.toHaveBeenCalled();
  const result = await request({ access });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual([{ model: "model", efforts: ["high"] }]);
  expect(catalog).toHaveBeenCalledWith(access, expect.any(AbortSignal));
  expect(agent.run).not.toHaveBeenCalled();
});

test("a catalog failure does not expose provider error contents", async (t) => {
  const origin = await listen(t, undefined, async () => {
    throw new Error("secret-token");
  });
  const response = await fetch(`${origin}/codex/models`, {
    method: "POST",
    body: JSON.stringify({
      access: {
        accessToken: "test-access",
        accountId: "test-account",
        connectionVersion: randomUUID(),
        accessVersion: randomUUID(),
      },
    }),
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "runner_error" });
});

test("an active catalog prevents jobs and overlapping catalog requests", async (t) => {
  let ready = () => {};
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const origin = await listen(t, undefined, async () => {
    ready();
    await gate;
    return [{ model: "model", efforts: ["high"] }];
  });
  const catalog = () =>
    fetch(`${origin}/codex/models`, {
      method: "POST",
      body: JSON.stringify({
        access: {
          accessToken: "test-access",
          accountId: "test-account",
          connectionVersion: randomUUID(),
          accessVersion: randomUUID(),
        },
      }),
    });
  const first = catalog();
  try {
    await started;
    expect((await catalog()).status).toBe(409);
    expect(
      (await sendJob(origin, diagnosticJob(Date.now() + 60_000))).status,
    ).toBe(409);
  } finally {
    release();
    await first;
  }
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
      await (await fetch(`${origin}/job/${runId}`)).json(),
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
    await (await nativeFetch(`${origin}/job/${job.runId}`)).json(),
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

test("executes the selected agent once and rejects a different job", async (t) => {
  let calls = 0;
  const origin = await listen(t, {
    async run(job) {
      calls++;
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
  expect((await sendJob(origin, { ...job, runId: randomUUID() })).status).toBe(
    409,
  );
  expect(calls).toBe(1);
  const result = v.parse(
    RunnerStatus,
    await (await fetch(`${origin}/job/${job.runId}`)).json(),
  );
  assert(result.status === "succeeded");
  expect(result.reply).toBe("Received Fix the issue");
  expect(result.events.map((event) => event.type)).toStrictEqual([
    "job_started",
    "job_succeeded",
  ]);
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
    await (await fetch(`${origin}/job/${job.runId}`)).json(),
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
    await (await fetch(`${origin}/job/${job.runId}`)).json(),
  );
  assert(result.status === "failed");
  expect(result.errorCode).toBe("agent_failed");
  expect(result.events.map((event) => event.type)).toStrictEqual([
    "job_started",
    "job_failed",
  ]);
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
  const response = await fetch(`${origin}/job/${job.runId}`);
  expect(v.parse(RunnerStatus, await response.json())).toMatchObject({
    status: "failed",
    errorCode: "sandbox_unavailable",
  });
});

test("execution modes preserve legacy jobs and validate planning contracts", () => {
  const legacy = {
    version: 1,
    engine: "fake",
    runId: randomUUID(),
    prompt: "Investigate",
    deadlineAt: Date.now() + 1000,
  };
  expect(v.safeParse(RunnerJobSchema, legacy).success).toBe(true);
  expect(
    v.safeParse(RunnerJobSchema, { ...legacy, mode: "plan" }).success,
  ).toBe(true);
  expect(
    v.safeParse(RunnerJobSchema, { ...legacy, mode: "write" }).success,
  ).toBe(false);
  expect(
    v.parse(ExecutionContext, { version: 1, engine: "fake" }).mode,
  ).toBeUndefined();
  expect(
    v.parse(ExecutionContext, { version: 1, engine: "fake", mode: "plan" })
      .mode,
  ).toBe("plan");
  expect(
    v.safeParse(ExecutionContext, { version: 1, engine: "fake", mode: "write" })
      .success,
  ).toBe(false);
  const result = {
    status: "succeeded",
    reply: "Which behavior?",
    plan: { planPresented: false, needsAnswer: true },
    events: [],
  };
  expect(v.safeParse(RunnerStatus, result).success).toBe(true);
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
    lease: {
      url: "https://tailos.example/_runner/runs/1/credentials",
      bearer: "b".repeat(64),
    },
  } satisfies RunnerJob;

  // A job cannot mix the Codex and Claude credential shapes.
  const { lease, ...withoutLease } = job;
  expect(
    v.safeParse(RunnerJobSchema, { ...withoutLease, refresh: lease }).success,
  ).toBe(false);
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
    const status = await fetch(`${origin}/job/${job.runId}`);
    expect(await status.json()).toMatchObject({
      status: "succeeded",
      reply: "from Claude",
    });
  });
  expect(run.mock.calls[0]![0]).toEqual(job);
});

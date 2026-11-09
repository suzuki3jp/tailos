import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { assert, expect, test, type TestContext } from "vitest";
import { runnerStatusSchema, type RunnerJob } from "@meguri/core/runner";
import * as v from "valibot";
import {
  AgentSandboxUnavailable,
  fakeAgent,
  type AgentAdapter,
} from "./agent.ts";
import { codexAgent } from "./codex-agent.ts";
import { createRunnerServer } from "./server.ts";

async function listen(t: TestContext, agent?: AgentAdapter) {
  const server = createRunnerServer({
    fake: agent ?? fakeAgent,
    codex: codexAgent,
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

test("executes the selected agent once and rejects a different job", async (t) => {
  let calls = 0;
  const origin = await listen(t, {
    async run(job) {
      calls++;
      return `Received ${job.prompt}`;
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
    runnerStatusSchema,
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
      return "unexpected";
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
    runnerStatusSchema,
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
      return "";
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
    runnerStatusSchema,
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
  expect(v.parse(runnerStatusSchema, await response.json())).toMatchObject({
    status: "failed",
    errorCode: "sandbox_unavailable",
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import type { RunnerJob } from "@meguri/core/runner";
import type { AgentAdapter } from "./agent.ts";
import { createRunnerServer } from "./server.ts";

async function listen(t: TestContext, agent?: AgentAdapter) {
  const server = createRunnerServer(agent);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address === "object");
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
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "runner" });
  assert.equal(
    (await fetch(`${origin}/health`, { method: "POST" })).status,
    404,
  );
  assert.equal((await fetch(`${origin}/`)).status, 404);
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
  assert.equal((await sendJob(origin, { ...job, prompt: "" })).status, 400);
  assert.equal((await sendJob(origin, job)).status, 202);
  assert.equal((await sendJob(origin, job)).status, 202);
  assert.equal(
    (await sendJob(origin, { ...job, runId: randomUUID() })).status,
    409,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await (await fetch(`${origin}/job/${job.runId}`)).json(), {
    status: "succeeded",
    reply: "Received Fix the issue",
  });
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
  assert.equal((await sendJob(origin, job)).status, 202);
  assert.ok(signal);
  if (!signal.aborted) await once(signal, "abort");
  assert.deepEqual(await (await fetch(`${origin}/job/${job.runId}`)).json(), {
    status: "failed",
    errorCode: "deadline_exceeded",
  });
});

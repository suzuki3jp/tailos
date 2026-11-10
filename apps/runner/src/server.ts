import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import {
  checkedPublicationSchema,
  maxPublicationBytes,
  runnerJobSchema,
  runnerStatusSchema,
  type CheckedPublication,
  type RunnerEvent,
  type RunnerJob,
  type RunnerStatus,
} from "@tailos/core/runner";
import * as v from "valibot";
import {
  AgentSandboxUnavailable,
  fakeAgent,
  PublicationFailed,
  type AgentAdapter,
} from "./agent.ts";
import { checkCodexWorkspace, codexAgent } from "./codex-agent.ts";
import { runInGitWorkspace } from "./git-workspace.ts";

type CurrentJob = { input: RunnerJob; state: RunnerStatus };

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 32 * 1024) {
      request.resume();
      return null;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function json(response: ServerResponse, code: number, body: object) {
  response
    .writeHead(code, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));
}

async function stagePublication(
  job: Extract<RunnerJob, { engine: "codex" }>,
  work: Omit<CheckedPublication, "kind" | "events">,
  events: RunnerEvent[],
  signal: AbortSignal,
) {
  const url = new URL("publication", job.refresh.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid publication URL");
  const body = JSON.stringify(
    v.parse(checkedPublicationSchema, {
      kind: "checked",
      ...work,
      events: [...events, { type: "job_succeeded", at: Date.now() }],
    }),
  );
  if (Buffer.byteLength(body) > maxPublicationBytes)
    throw new PublicationFailed("unsupported_changes");
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${job.refresh.bearer}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  await response.body?.cancel();
  if (response.status !== 204)
    throw new Error("Publication checkpoint unavailable");
}

async function execute(job: CurrentJob, agent: AgentAdapter) {
  const events: RunnerEvent[] = [{ type: "job_started", at: Date.now() }];
  const remaining = job.input.deadlineAt - Date.now();
  if (remaining <= 0) {
    events.push({ type: "job_failed", at: Date.now() });
    job.state = { status: "failed", errorCode: "deadline_exceeded", events };
    return;
  }
  const signal = AbortSignal.timeout(remaining);
  try {
    const input = job.input;
    const result =
      input.engine === "codex" && input.checkout
        ? await runInGitWorkspace(
            input.checkout,
            signal,
            (cwd) => agent.run(input, signal, cwd),
            (cwd) => checkCodexWorkspace(cwd, signal),
            (work) => stagePublication(input, work, events, signal),
          )
        : { reply: (await agent.run(input, signal)).reply };
    signal.throwIfAborted();
    job.state = v.parse(runnerStatusSchema, {
      status: "succeeded",
      ...result,
      events: [...events, { type: "job_succeeded", at: Date.now() }],
    });
  } catch (error) {
    events.push({ type: "job_failed", at: Date.now() });
    const errorCode =
      error instanceof AgentSandboxUnavailable
        ? "sandbox_unavailable"
        : error instanceof PublicationFailed
          ? error.code
          : "agent_failed";
    job.state = {
      status: "failed",
      errorCode: signal.aborted ? "deadline_exceeded" : errorCode,
      events,
    };
  }
}

export function createRunnerServer(
  agents: Record<RunnerJob["engine"], AgentAdapter> = {
    fake: fakeAgent,
    codex: codexAgent,
  },
) {
  let current: CurrentJob | undefined;
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, { status: "ok", service: "runner" });
        return;
      }
      if (request.method === "POST" && request.url === "/job") {
        const parsed = v.safeParse(runnerJobSchema, await readJson(request));
        if (
          !parsed.success ||
          parsed.output.deadlineAt > Date.now() + 30 * 60_000
        ) {
          json(response, 400, { error: "invalid_job" });
          return;
        }

        if (!current) {
          current = { input: parsed.output, state: { status: "running" } };
          void execute(current, agents[parsed.output.engine]);
        } else if (
          JSON.stringify(current.input) !== JSON.stringify(parsed.output)
        ) {
          json(response, 409, { error: "runner_already_assigned" });
          return;
        }
        json(response, 202, { runId: current.input.runId });
        return;
      }
      if (
        request.method === "GET" &&
        current &&
        request.url === `/job/${current.input.runId}`
      ) {
        json(response, 200, current.state);
        return;
      }
      response.writeHead(404).end();
    } catch {
      json(response, 500, { error: "runner_error" });
    }
  });
}

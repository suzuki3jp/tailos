import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import {
  runnerJobSchema,
  type RunnerJob,
  type RunnerStatus,
} from "@meguri/core/runner";
import * as v from "valibot";
import { fakeAgent, type AgentAdapter } from "./agent.ts";

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

async function execute(job: CurrentJob, agent: AgentAdapter) {
  const remaining = job.input.deadlineAt - Date.now();
  if (remaining <= 0) {
    job.state = { status: "failed", errorCode: "deadline_exceeded" };
    return;
  }
  const signal = AbortSignal.timeout(remaining);
  try {
    const reply = await agent.run(job.input, signal);
    signal.throwIfAborted();
    job.state = { status: "succeeded", reply };
  } catch {
    job.state = {
      status: "failed",
      errorCode: signal.aborted ? "deadline_exceeded" : "agent_failed",
    };
  }
}

export function createRunnerServer(agent = fakeAgent) {
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
          void execute(current, agent);
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

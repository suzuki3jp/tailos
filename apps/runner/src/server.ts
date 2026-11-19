import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import {
  CheckedPublication,
  maxPublicationBytes,
  maxRunnerJobBytes,
  RunnerJob,
  RunnerStatus,
  type RunnerEvent,
} from "@tailos/core/runner";
import * as v from "valibot";
import {
  AgentSandboxUnavailable,
  fakeAgent,
  PublicationFailed,
  type AgentAdapter,
} from "@/agent.ts";
import { claudeAgent } from "@/claude-agent.ts";
import { codexAgent } from "@/codex-agent.ts";
import { runInGitWorkspace } from "@/git-workspace.ts";
import { RunnerDiagnostics } from "@/diagnostics.ts";

type CurrentJob = { input: RunnerJob; state: RunnerStatus };

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxRunnerJobBytes) {
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
  mode: RunnerJob["mode"],
  lease: { url: string; bearer: string },
  work: Omit<CheckedPublication, "kind" | "events">,
  events: RunnerEvent[],
  signal: AbortSignal,
) {
  if (mode === "plan") throw new Error("Planning cannot publish");
  const url = new URL("publication", lease.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid publication URL");
  const body = JSON.stringify(
    v.parse(CheckedPublication, {
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
      Authorization: `Bearer ${lease.bearer}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  await response.body?.cancel();
  if (response.status !== 204)
    throw new Error("Publication checkpoint unavailable");
}

function jobErrorCode(error: unknown) {
  if (error instanceof AgentSandboxUnavailable) return "sandbox_unavailable";
  if (error instanceof PublicationFailed) return error.code;
  return "agent_failed";
}

async function execute(
  job: CurrentJob,
  agent: AgentAdapter,
  requestId: string,
) {
  const diagnostics = new RunnerDiagnostics(job.input, fetch, requestId);
  const span = diagnostics.start(
    "runner",
    JSON.stringify({
      engine: job.input.engine,
      deadlineAt: job.input.deadlineAt,
    }),
  );
  diagnostics.setParentSpan(span);
  const events: RunnerEvent[] = [{ type: "job_started", at: Date.now() }];
  const remaining = job.input.deadlineAt - Date.now();
  if (remaining <= 0) {
    events.push({ type: "job_failed", at: Date.now() });
    diagnostics.end(span, { outcome: "failed", reason: "deadline" });
    await diagnostics.finish(0);
    job.state = { status: "failed", errorCode: "deadline_exceeded", events };
    return;
  }
  const signal = AbortSignal.timeout(remaining);
  let terminal: RunnerStatus = {
    status: "failed",
    errorCode: "agent_failed",
    events,
  };
  try {
    const input = job.input;
    const result =
      input.engine !== "fake" && input.checkout
        ? await runInGitWorkspace(
            input.checkout,
            signal,
            (cwd) => agent.run(input, signal, cwd, diagnostics),
            async (work) => {
              if (input.deadlineAt - Date.now() > 2_000)
                await diagnostics.flush(1_000);
              return stagePublication(
                input.mode,
                input.engine === "codex" ? input.refresh : input.lease,
                work,
                events,
                signal,
              );
            },
            undefined,
            diagnostics,
            input.mode,
          )
        : await agent
            .run(input, signal, undefined, diagnostics)
            .then(({ reply, plan, sessionTitle }) => ({
              reply,
              ...(sessionTitle && { sessionTitle }),
              ...(input.mode === "plan" && { plan }),
            }));
    signal.throwIfAborted();
    terminal = v.parse(RunnerStatus, {
      status: "succeeded",
      ...result,
      events: [...events, { type: "job_succeeded", at: Date.now() }],
    });
    diagnostics.end(span, { outcome: "succeeded" }, result.reply);
  } catch (error) {
    events.push({ type: "job_failed", at: Date.now() });
    terminal = {
      status: "failed",
      errorCode: signal.aborted ? "deadline_exceeded" : jobErrorCode(error),
      events,
    };
    diagnostics.end(span, {
      outcome: "failed",
      ...(signal.aborted ? { reason: "deadline" as const } : {}),
    });
  } finally {
    // Do not expose a terminal status until its bounded final flush has had a
    // chance to finish: the controller destroys the container after that status.
    await diagnostics.finish(
      Math.max(0, Math.min(4_000, job.input.deadlineAt - Date.now() - 100)),
    );
    job.state = terminal;
  }
}

export function createRunnerServer(
  agents: Record<RunnerJob["engine"], AgentAdapter> = {
    fake: fakeAgent,
    codex: codexAgent,
    claude: claudeAgent,
  },
) {
  let current: CurrentJob | undefined;
  return createServer(async (request, response) => {
    const requestId = crypto.randomUUID();
    response.setHeader("X-Request-ID", requestId);
    try {
      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, { status: "ok", service: "runner" });
        return;
      }
      if (request.method === "POST" && request.url === "/job") {
        const parsed = v.safeParse(RunnerJob, await readJson(request));
        if (
          !parsed.success ||
          parsed.output.deadlineAt > Date.now() + 30 * 60_000
        ) {
          json(response, 400, { error: "invalid_job" });
          return;
        }

        if (!current) {
          current = { input: parsed.output, state: { status: "running" } };
          void execute(current, agents[parsed.output.engine], requestId);
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

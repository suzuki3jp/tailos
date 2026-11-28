import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  maxContinuityBytes,
  maxRunnerJobBytes,
  RunnerJob,
  RunnerStatus,
  type RunnerEvent,
} from "@tailos/core/runner";
import * as v from "valibot";
import {
  AgentSandboxUnavailable,
  fakeAgent,
  type AgentAdapter,
} from "@/agent.ts";
import { claudeAgent } from "@/claude-agent.ts";
import { codexAgent } from "@/codex-agent.ts";
import {
  runInGitWorkspace,
  type WorkspaceContinuity,
} from "@/git-workspace.ts";
import { RunnerDiagnostics } from "@/diagnostics.ts";
import { diagnosticErrorBody } from "@/diagnostic-operations.ts";

/** The Turn's saved work, as the controller collects it after the Turn. */
type SavedWorkState =
  | { state: "pending" }
  | { state: "ready"; archive: Buffer }
  | { state: "skipped" }
  | { state: "unavailable" };
type CurrentJob = {
  input: RunnerJob;
  state: RunnerStatus;
  key: Buffer;
  saved?: SavedWorkState;
};

// Agent commands may reach this server: the Run's controller proves itself
// with the key it sent with the job. No Agent runs before a job arrives, so
// the first key is the controller's, and it lives only in this process.
function controlKey(request: IncomingMessage) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(
    request.headers.authorization ?? "",
  );
  return match ? createHash("sha256").update(match[1]!).digest() : undefined;
}
const sameKey = (a: Buffer | undefined, b: Buffer) =>
  a !== undefined && timingSafeEqual(a, b);

async function readBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, maxRunnerJobBytes);
  try {
    return body && JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function json(response: ServerResponse, code: number, body: object) {
  response
    .writeHead(code, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));
}

function jobErrorCode(error: unknown) {
  if (error instanceof AgentSandboxUnavailable) return "sandbox_unavailable";
  return "agent_failed";
}

/** A job is in progress until its status and saved work are final. */
const busy = (job: CurrentJob | undefined) =>
  job !== undefined &&
  (job.state.status === "running" || job.saved?.state === "pending");

function savedWorkState(
  result: Parameters<WorkspaceContinuity["saved"]>[0],
): SavedWorkState {
  if ("archive" in result) return { state: "ready", archive: result.archive };
  if ("skipped" in result) return { state: "skipped" };
  return { state: "unavailable" };
}

/** What the controller asked to carry over, and where this Turn's goes. */
function workspaceContinuity(
  job: CurrentJob,
  previous: Buffer | undefined,
): WorkspaceContinuity | undefined {
  const input = job.input;
  if (input.engine === "fake" || !input.continuity) return undefined;
  job.saved = { state: "pending" };
  const restore = input.continuity.restore;
  return {
    // Saved work that never arrived cannot be carried over.
    ...(restore && {
      restore: restore === "saved" ? (previous ?? "lost") : "lost",
    }),
    // Set in the container, so that the work outlives this process's job.
    ...(process.env.TAILOS_WORK_DIR && {
      workDir: process.env.TAILOS_WORK_DIR,
    }),
    saved(result) {
      job.saved = savedWorkState(result);
    },
  };
}

async function execute(
  job: CurrentJob,
  agent: AgentAdapter,
  requestId: string,
  previous?: Buffer,
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
    const continuity = workspaceContinuity(job, previous);
    const result =
      input.engine !== "fake" && input.checkout
        ? await runInGitWorkspace(
            input.checkout,
            signal,
            ({ cwd, gitDir }, conversation) =>
              agent.run(input, signal, cwd, diagnostics, conversation, gitDir),
            undefined,
            diagnostics,
            continuity,
          )
        : await agent
            .run(input, signal, undefined, diagnostics)
            .then(({ reply, sessionTitle }) => ({
              reply,
              ...(sessionTitle && { sessionTitle }),
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
    diagnostics.end(
      span,
      {
        outcome: "failed",
        ...(signal.aborted ? { reason: "deadline" as const } : {}),
      },
      diagnosticErrorBody(error),
    );
  } finally {
    // Do not expose a terminal status until its bounded final flush has had a
    // chance to finish: the controller destroys the container after that status.
    await diagnostics.finish(
      Math.max(0, Math.min(4_000, job.input.deadlineAt - Date.now() - 100)),
    );
    // A Turn that never reached the workspace leaves nothing to save.
    if (job.saved?.state === "pending") job.saved = { state: "skipped" };
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
  // The first control request names the controller: no Agent runs before it.
  let controller: Buffer | undefined;
  let previous: Buffer | undefined;
  return createServer(async (request, response) => {
    const requestId = crypto.randomUUID();
    response.setHeader("X-Request-ID", requestId);
    try {
      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, { status: "ok", service: "runner" });
        return;
      }
      if (request.method === "PUT" && request.url === "/continuity") {
        const key = controlKey(request);
        if (!key || (controller && !sameKey(key, controller))) {
          request.resume();
          json(response, 401, { error: "unauthorized" });
          return;
        }
        if (busy(current)) {
          request.resume();
          json(response, 409, { error: "runner_already_assigned" });
          return;
        }
        const body = await readBody(request, maxContinuityBytes);
        if (!body) {
          json(response, 413, { error: "saved_work_too_large" });
          return;
        }
        controller ??= key;
        previous = body;
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && request.url === "/job") {
        const key = controlKey(request);
        if (!key || (controller && !sameKey(key, controller))) {
          request.resume();
          json(response, 401, { error: "unauthorized" });
          return;
        }
        controller ??= key;
        const parsed = v.safeParse(RunnerJob, await readJson(request));
        if (
          !parsed.success ||
          parsed.output.deadlineAt > Date.now() + 30 * 60_000
        ) {
          json(response, 400, { error: "invalid_job" });
          return;
        }
        const resent =
          current &&
          JSON.stringify(current.input) === JSON.stringify(parsed.output);
        // A kept container takes the Session's next Turn once this one ends.
        if (!resent && !busy(current)) {
          current = {
            input: parsed.output,
            state: { status: "running" },
            key,
          };
          void execute(
            current,
            agents[parsed.output.engine],
            requestId,
            previous,
          );
          previous = undefined;
        } else if (!resent) {
          json(response, 409, { error: "runner_already_assigned" });
          return;
        }
        json(response, 202, { runId: current!.input.runId });
        return;
      }
      if (
        request.method === "GET" &&
        current &&
        request.url === `/job/${current.input.runId}/continuity`
      ) {
        if (!sameKey(controlKey(request), current.key)) {
          json(response, 401, { error: "unauthorized" });
          return;
        }
        const saved = current.saved;
        if (!saved) json(response, 404, { error: "not_saved" });
        else if (saved.state === "pending") json(response, 202, saved);
        else if (saved.state === "skipped") response.writeHead(204).end();
        else if (saved.state === "unavailable")
          json(response, 410, { error: "saved_work_unavailable" });
        else
          response
            .writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": saved.archive.length,
            })
            .end(saved.archive);
        return;
      }
      if (
        request.method === "GET" &&
        current &&
        request.url === `/job/${current.input.runId}`
      ) {
        if (!sameKey(controlKey(request), current.key)) {
          json(response, 401, { error: "unauthorized" });
          return;
        }
        json(response, 200, current.state);
        return;
      }
      response.writeHead(404).end();
    } catch {
      json(response, 500, { error: "runner_error" });
    }
  });
}

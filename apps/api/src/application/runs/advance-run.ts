import type { WriteRunArtifacts } from "@/application/runs/artifacts.ts";
import type { RunStatus } from "@tailos/core/run-status";
import {
  ExecutionContext,
  type RunnerEvent,
  type RunnerStatus,
} from "@tailos/core/runner";
import * as v from "valibot";

export type RunInput = {
  messageId: string;
  executionContext: string;
  deadlineAt: number;
};
/** The pull requests of the branches the Turn pushed. */
type PublicationResult = {
  kind: "pull_requests";
  pullRequests: { branch: string; url: string }[];
};
type RunOutcome =
  | {
      status: "succeeded";
      reply: string;
      sessionTitle?: string;
      events: RunnerEvent[];
      publicationResult?: PublicationResult;
      plan?: Extract<RunnerStatus, { status: "succeeded" }>["plan"];
    }
  | Extract<RunnerStatus, { status: "failed" }>
  | {
      status: "failed";
      errorCode:
        | "runner_unavailable"
        | "runner_lost"
        | "repository_unavailable"
        | "provider_unavailable"
        | "invalid_execution_context"
        | "artifact_write_failed"
        | "message_too_large";
      events?: RunnerEvent[];
    };

export type RunRequest = {
  runId: string;
  prompt: string;
  deadlineAt: number;
  context: ExecutionContext;
};

export type RunnerDriver = {
  start(job: RunRequest): Promise<RunnerStatus | RunOutcome>;
  poll(
    runId: string,
    context: ExecutionContext,
    deadlineAt: number,
  ): Promise<RunnerStatus | RunOutcome>;
};

type RunProgress =
  | { status: "running"; nextActionAt: number }
  | {
      status: "succeeded" | "failed";
    };

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function advanceRun(
  store: RunStore,
  runId: string,
  driver: RunnerDriver,
  writeArtifacts?: WriteRunArtifacts,
): Promise<RunProgress | undefined> {
  // A claimed run can have reached the agent even if the caller never got an
  // acknowledgement. Every later tick polls the same container.
  const claimed = await store.claim(runId, Date.now());
  const run = claimed ?? (await store.load(runId));
  if (!run) return undefined;

  const context = v.safeParse(
    ExecutionContext,
    parseJson(run.executionContext),
  );
  let outcome: RunnerStatus | RunOutcome;
  if (claimed && run.deadlineAt <= Date.now()) {
    outcome = { status: "failed", errorCode: "deadline_exceeded", events: [] };
  } else if (!context.success) {
    outcome = { status: "failed", errorCode: "invalid_execution_context" };
  } else if (claimed) {
    outcome = await dispatchNewRun(store, runId, run, context.output, driver);
  } else {
    outcome = await driver
      .poll(runId, context.output, run.deadlineAt)
      .catch(() => ({ status: "running" as const }));
  }
  if (outcome.status === "running" && run.deadlineAt > Date.now()) {
    return scheduleNext(store, runId, run.deadlineAt);
  }

  const status = await storeOutcome(
    store,
    runId,
    run.deadlineAt,
    outcome,
    writeArtifacts,
  );
  if (status === "running") return scheduleNext(store, runId, run.deadlineAt);
  return status === "succeeded" || status === "failed" ? { status } : undefined;
}

async function scheduleNext(
  store: RunStore,
  runId: string,
  deadlineAt: number,
): Promise<RunProgress> {
  const nextActionAt = Math.min(deadlineAt, Date.now() + 1_500);
  await store.schedule(runId, nextActionAt);
  return { status: "running", nextActionAt };
}

async function dispatchNewRun(
  store: RunStore,
  runId: string,
  run: RunInput,
  context: ExecutionContext,
  driver: RunnerDriver,
): Promise<RunnerStatus | RunOutcome> {
  const message = await store.readMessage(run.messageId);
  if (!message) {
    return { status: "failed", errorCode: "invalid_execution_context" };
  }
  return driver
    .start({
      runId,
      context,
      prompt: message.body,
      deadlineAt: run.deadlineAt,
    })
    .catch(() => ({ status: "running" as const }));
}

function publishedPullRequest(outcome: RunnerStatus | RunOutcome) {
  const result: PublicationResult | undefined =
    outcome.status === "succeeded" && "publicationResult" in outcome
      ? (outcome.publicationResult as PublicationResult | undefined)
      : undefined;
  return !!result?.pullRequests.length;
}

function completionResult(
  outcome: Extract<RunnerStatus | RunOutcome, { status: "succeeded" }>,
) {
  if (outcome.plan) return { kind: "plan", ...outcome.plan };
  if ("publicationResult" in outcome && outcome.publicationResult)
    return outcome.publicationResult;
  return { kind: "completed" };
}

async function storeOutcome(
  store: RunStore,
  runId: string,
  deadlineAt: number,
  result: RunnerStatus | RunOutcome,
  writeArtifacts?: WriteRunArtifacts,
) {
  let outcome =
    result.status === "running"
      ? {
          status: "failed" as const,
          errorCode: "deadline_exceeded" as const,
          events: [],
        }
      : result;

  const finishedAt = Date.now();
  const published = publishedPullRequest(outcome);
  const terminalEvent =
    outcome.status === "succeeded" ? "job_succeeded" : "job_failed";
  const finishedBeforeDeadline = outcome.events?.some(
    (event) => event.type === terminalEvent && event.at < deadlineAt,
  );
  if (finishedAt >= deadlineAt && !finishedBeforeDeadline && !published) {
    outcome = {
      status: "failed",
      errorCode: "deadline_exceeded",
      events: outcome.events ?? [],
    };
  }
  if (writeArtifacts) {
    try {
      const result =
        outcome.status === "failed"
          ? { status: outcome.status, errorCode: outcome.errorCode }
          : { status: outcome.status };
      await writeArtifacts(runId, finishedAt, result, outcome.events ?? []);
    } catch {
      // Detailed artifacts are best effort. Required execution history is
      // committed atomically by the RunStore, including a successful PR result.
    }
  }
  if (outcome.status === "failed")
    return failRun(store, runId, outcome.errorCode, finishedAt);

  const storedResult = JSON.stringify({
    version: 1,
    ...(outcome.sessionTitle && { sessionTitle: outcome.sessionTitle }),
    ...completionResult(outcome),
  });
  try {
    if (await store.complete(runId, outcome.reply, storedResult, finishedAt))
      return "succeeded";
  } catch {
    // Pull requests the Turn opened are part of its result: keep trying until
    // the Run's deadline.
    if (published && Date.now() < deadlineAt) {
      return "running";
    }
    return failRun(
      store,
      runId,
      "persistence_failed",
      finishedAt,
      published ? storedResult : null,
    );
  }
  return store.readStatus(runId);
}

export type RunStore = {
  claim(runId: string, now: number): Promise<RunInput | null>;
  load(runId: string): Promise<RunInput | null>;
  schedule(runId: string, nextActionAt: number): Promise<void>;
  readMessage(messageId: string): Promise<{ body: string } | null>;
  complete(
    runId: string,
    reply: string,
    result: string,
    finishedAt: number,
  ): Promise<boolean>;
  readStatus(runId: string): Promise<RunStatus | undefined>;
  fail(
    runId: string,
    code: string,
    finishedAt: number,
    result?: string | null,
  ): Promise<"failed" | undefined>;
};

async function failRun(
  store: RunStore,
  runId: string,
  code: string,
  finishedAt: number,
  result: string | null = null,
) {
  return (
    (await store.fail(runId, code, finishedAt, result)) ??
    store.readStatus(runId)
  );
}

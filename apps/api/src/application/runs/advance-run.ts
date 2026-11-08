import type { WriteRunArtifacts } from "./artifacts.ts";
import {
  executionContextSchema,
  type RunnerEvent,
  type ExecutionContext,
  type RunnerStatus,
} from "@meguri/core/runner";
import * as v from "valibot";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";
export type RunInput = {
  messageId: string;
  executionContext: string;
  deadlineAt: number;
};
type RunOutcome =
  | Exclude<RunnerStatus, { status: "running" }>
  | {
      status: "failed";
      errorCode:
        | "runner_unavailable"
        | "runner_lost"
        | "provider_unavailable"
        | "invalid_execution_context"
        | "artifact_write_failed";
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
  poll(runId: string): Promise<RunnerStatus | RunOutcome>;
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

  let outcome: RunnerStatus | RunOutcome;
  if (claimed && run.deadlineAt <= Date.now()) {
    outcome = { status: "failed", errorCode: "deadline_exceeded", events: [] };
  } else if (claimed) {
    outcome = await dispatchNewRun(store, runId, run, driver);
  } else {
    outcome = await driver
      .poll(runId)
      .catch(() => ({ status: "running" as const }));
  }

  if (outcome.status === "running" && run.deadlineAt > Date.now()) {
    const nextActionAt = Math.min(run.deadlineAt, Date.now() + 1_500);
    await store.schedule(runId, nextActionAt);
    return { status: "running", nextActionAt };
  }

  const status = await storeOutcome(
    store,
    runId,
    run.deadlineAt,
    outcome,
    writeArtifacts,
  );
  return status === "succeeded" || status === "failed" ? { status } : undefined;
}

async function dispatchNewRun(
  store: RunStore,
  runId: string,
  run: RunInput,
  driver: RunnerDriver,
): Promise<RunnerStatus | RunOutcome> {
  const message = await store.readMessage(run.messageId);
  const context = v.safeParse(
    executionContextSchema,
    parseJson(run.executionContext),
  );
  if (!context.success || !message) {
    return { status: "failed", errorCode: "invalid_execution_context" };
  }
  return driver
    .start({
      runId,
      context: context.output,
      prompt: message.body,
      deadlineAt: run.deadlineAt,
    })
    .catch(() => ({ status: "running" as const }));
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
  const terminalEvent =
    outcome.status === "succeeded" ? "job_succeeded" : "job_failed";
  const finishedBeforeDeadline = outcome.events?.some(
    (event) => event.type === terminalEvent && event.at < deadlineAt,
  );
  if (finishedAt >= deadlineAt && !finishedBeforeDeadline) {
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
      if (outcome.status === "succeeded")
        outcome = { status: "failed", errorCode: "artifact_write_failed" };
    }
  }
  if (outcome.status === "failed") {
    return failRun(store, runId, outcome.errorCode, finishedAt);
  }

  try {
    if (
      await store.complete(
        runId,
        outcome.reply,
        JSON.stringify({ version: 1, kind: "completed" }),
        finishedAt,
      )
    )
      return "succeeded";
  } catch {
    return failRun(store, runId, "persistence_failed", finishedAt);
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
  ): Promise<"failed" | undefined>;
};

async function failRun(
  store: RunStore,
  runId: string,
  code: string,
  finishedAt: number,
) {
  return (await store.fail(runId, code, finishedAt)) ?? store.readStatus(runId);
}

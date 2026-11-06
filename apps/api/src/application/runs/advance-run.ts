import {
  executionContextSchema,
  type RunnerJob,
  type RunnerStatus,
} from "@meguri/core/runner";
import * as v from "valibot";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";
export type RunInput = {
  id: string;
  sessionId: string;
  messageId: string;
  executionContext: string;
  deadlineAt: number;
};
type RunOutcome =
  | Exclude<RunnerStatus, { status: "running" }>
  | {
      status: "failed";
      errorCode: "runner_unavailable" | "invalid_execution_context";
    };

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function executeRun(
  store: RunStore,
  runId: string,
  dispatch: (job: RunnerJob) => Promise<RunOutcome>,
): Promise<RunStatus | undefined> {
  const run = await store.claim(runId);
  if (!run) return store.readStatus(runId);

  const message = await store.readMessage(run.messageId);
  const context = v.safeParse(
    executionContextSchema,
    parseJson(run.executionContext),
  );
  let outcome: RunOutcome;
  if (run.deadlineAt <= Date.now()) {
    outcome = { status: "failed", errorCode: "deadline_exceeded" };
  } else if (!context.success || !message) {
    outcome = { status: "failed", errorCode: "invalid_execution_context" };
  } else {
    try {
      outcome = await dispatch({
        version: 1,
        runId,
        engine: context.output.engine,
        prompt: message.body,
        deadlineAt: run.deadlineAt,
      });
    } catch {
      outcome = { status: "failed", errorCode: "runner_unavailable" };
    }
  }

  const finishedAt = Date.now();
  if (finishedAt >= run.deadlineAt) {
    outcome = { status: "failed", errorCode: "deadline_exceeded" };
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
  claim(runId: string): Promise<RunInput | null>;
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

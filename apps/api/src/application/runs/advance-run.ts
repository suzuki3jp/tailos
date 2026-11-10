import type { WriteRunArtifacts } from "./artifacts.ts";
import {
  executionContextSchema,
  type RunnerEvent,
  type ExecutionContext,
  type RunnerStatus,
} from "@meguri/core/runner";
import * as v from "valibot";
import {
  pendingPublication,
  publicationDeadline,
  type PendingPublication,
} from "./publication.ts";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";
export type RunInput = {
  messageId: string;
  executionContext: string;
  deadlineAt: number;
  stepState: string | null;
};
type PublicationResult =
  | { kind: "no_changes" }
  | { kind: "pull_request"; url: string; branch: string; sha: string };
type RunOutcome =
  | {
      status: "succeeded";
      reply: string;
      events: RunnerEvent[];
      publicationResult?: PublicationResult;
    }
  | Extract<RunnerStatus, { status: "failed" }>
  | {
      status: "failed";
      errorCode:
        | "runner_unavailable"
        | "runner_lost"
        | "repository_unavailable"
        | "publication_unconfirmed"
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
  poll(
    runId: string,
    context: ExecutionContext,
    deadlineAt: number,
    stepState: string | null,
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
    executionContextSchema,
    parseJson(run.executionContext),
  );
  let outcome: RunnerStatus | RunOutcome;
  let stepState = run.stepState;
  let pending = claimed ? null : pendingPublication(stepState);
  if (claimed && run.deadlineAt <= Date.now()) {
    outcome = { status: "failed", errorCode: "deadline_exceeded", events: [] };
  } else if (!context.success) {
    outcome = { status: "failed", errorCode: "invalid_execution_context" };
  } else if (claimed) {
    outcome = await dispatchNewRun(store, runId, run, context.output, driver);
  } else {
    outcome = await driver
      .poll(runId, context.output, run.deadlineAt, run.stepState)
      .catch(() => ({ status: "running" as const }));
  }

  if (
    !claimed &&
    (pending || outcome.status !== "running" || Date.now() >= run.deadlineAt)
  ) {
    // A push checkpoint or reconciliation timestamp may have changed during polling.
    stepState = (await store.load(runId))?.stepState ?? stepState;
    const latest = pendingPublication(stepState);
    if (!pending && latest) outcome = { status: "running" };
    pending = latest;
  }
  const recoveryDeadline = publicationDeadline(stepState, run.deadlineAt);
  const pollDeadline = pending ? recoveryDeadline : run.deadlineAt;
  if (outcome.status === "running" && pollDeadline > Date.now()) {
    return scheduleNext(store, runId, pollDeadline);
  }
  if (outcome.status === "running" && pending) {
    outcome = { status: "failed", errorCode: "publication_unconfirmed" };
  }

  const status = await storeOutcome(
    store,
    runId,
    run.deadlineAt,
    recoveryDeadline,
    outcome,
    pending,
    writeArtifacts,
  );
  if (status === "running") return scheduleNext(store, runId, recoveryDeadline);
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

async function storeOutcome(
  store: RunStore,
  runId: string,
  deadlineAt: number,
  recoveryDeadline: number,
  result: RunnerStatus | RunOutcome,
  pending: PendingPublication | null,
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
  const published =
    outcome.status === "succeeded" &&
    "publicationResult" in outcome &&
    outcome.publicationResult?.kind === "pull_request";
  const unconfirmed =
    outcome.status === "failed" &&
    outcome.errorCode === "publication_unconfirmed";
  const terminalEvent =
    outcome.status === "succeeded" ? "job_succeeded" : "job_failed";
  const finishedBeforeDeadline = outcome.events?.some(
    (event) => event.type === terminalEvent && event.at < deadlineAt,
  );
  if (
    finishedAt >= deadlineAt &&
    !finishedBeforeDeadline &&
    !published &&
    !unconfirmed
  ) {
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
      if (outcome.status === "succeeded" && !published)
        outcome = { status: "failed", errorCode: "artifact_write_failed" };
    }
  }
  if (outcome.status === "failed") {
    const result =
      pending && outcome.errorCode === "publication_unconfirmed"
        ? JSON.stringify({
            version: 1,
            kind: "publication_unconfirmed",
            branch: pending.branch,
            ...(pending.kind === "checked" ? {} : { sha: pending.sha }),
          })
        : null;
    return failRun(store, runId, outcome.errorCode, finishedAt, result);
  }

  const storedResult = JSON.stringify({
    version: 1,
    ...("publicationResult" in outcome && outcome.publicationResult
      ? outcome.publicationResult
      : { kind: "completed" }),
  });
  try {
    if (await store.complete(runId, outcome.reply, storedResult, finishedAt))
      return "succeeded";
  } catch {
    if (published && Date.now() < recoveryDeadline) {
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

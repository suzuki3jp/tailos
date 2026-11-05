import type { D1Database } from "@cloudflare/workers-types";
import {
  executionContextSchema,
  type RunnerEvent,
  type ExecutionContext,
  type RunnerStatus,
} from "@meguri/core/runner";
import * as v from "valibot";
import { writeRunArtifacts, type RunArtifactsBucket } from "./run-artifacts.ts";

type RunStatus = "queued" | "running" | "succeeded" | "failed";
type RunInput = {
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
  db: D1Database,
  runId: string,
  driver: RunnerDriver,
  artifacts?: RunArtifactsBucket,
): Promise<RunProgress | undefined> {
  // A claimed run can have reached the agent even if the caller never got an
  // acknowledgement. Every later tick polls the same container.
  const claimed = await db
    .prepare(
      `UPDATE runs SET status = 'running', next_action_at = ?
     WHERE id = ? AND status = 'queued'
     RETURNING start_message_id AS messageId, execution_context AS executionContext,
               deadline_at AS deadlineAt`,
    )
    .bind(Date.now(), runId)
    .first<RunInput>();
  const run =
    claimed ??
    (await db
      .prepare(
        `SELECT start_message_id AS messageId, execution_context AS executionContext,
            deadline_at AS deadlineAt FROM runs WHERE id = ? AND status = 'running'`,
      )
      .bind(runId)
      .first<RunInput>());
  if (!run) return undefined;

  let outcome: RunnerStatus | RunOutcome;
  if (run.deadlineAt <= Date.now()) {
    outcome = { status: "failed", errorCode: "deadline_exceeded", events: [] };
  } else if (claimed) {
    outcome = await dispatchNewRun(db, runId, run, driver);
  } else {
    outcome = await driver
      .poll(runId)
      .catch(() => ({ status: "running" as const }));
  }

  if (outcome.status === "running" && run.deadlineAt > Date.now()) {
    const nextActionAt = Math.min(run.deadlineAt, Date.now() + 1_500);
    await db
      .prepare(
        "UPDATE runs SET next_action_at = ? WHERE id = ? AND status = 'running'",
      )
      .bind(nextActionAt, runId)
      .run();
    return { status: "running", nextActionAt };
  }

  const status = await storeOutcome(
    db,
    runId,
    run.deadlineAt,
    outcome,
    artifacts,
  );
  return status === "succeeded" || status === "failed" ? { status } : undefined;
}

async function dispatchNewRun(
  db: D1Database,
  runId: string,
  run: RunInput,
  driver: RunnerDriver,
): Promise<RunnerStatus | RunOutcome> {
  const message = await db
    .prepare("SELECT body FROM session_messages WHERE id = ?")
    .bind(run.messageId)
    .first<{ body: string }>();
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
  db: D1Database,
  runId: string,
  deadlineAt: number,
  result: RunnerStatus | RunOutcome,
  artifacts?: RunArtifactsBucket,
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
  if (finishedAt >= deadlineAt) {
    outcome = {
      status: "failed",
      errorCode: "deadline_exceeded",
      events: outcome.events ?? [],
    };
  }
  if (artifacts) {
    try {
      const result =
        outcome.status === "failed"
          ? { status: outcome.status, errorCode: outcome.errorCode }
          : { status: outcome.status };
      await writeRunArtifacts(
        artifacts,
        runId,
        finishedAt,
        result,
        outcome.events ?? [],
      );
    } catch {
      outcome = { status: "failed", errorCode: "artifact_write_failed" };
    }
  }
  if (outcome.status === "failed") {
    return failRun(db, runId, outcome.errorCode, finishedAt);
  }

  try {
    const [, update] = await db.batch([
      db
        .prepare(
          `INSERT INTO session_messages (id, session_id, seq, author_kind, body, run_id, created_at)
         SELECT ?, session_id, (SELECT coalesce(max(seq), 0) + 1 FROM session_messages
                               WHERE session_id = runs.session_id),
                'agent', ?, id, ? FROM runs WHERE id = ? AND status = 'running'`,
        )
        .bind(crypto.randomUUID(), outcome.reply, finishedAt, runId),
      db
        .prepare(
          "UPDATE runs SET status = 'succeeded', result = ?, finished_at = ?, next_action_at = NULL WHERE id = ? AND status = 'running'",
        )
        .bind(
          JSON.stringify({ version: 1, kind: "completed" }),
          finishedAt,
          runId,
        ),
    ]);
    if (update?.meta.changes === 1) return "succeeded";
  } catch {
    return failRun(db, runId, "persistence_failed", finishedAt);
  }
  return readRunStatus(db, runId);
}

async function readRunStatus(db: D1Database, runId: string) {
  const stored = await db
    .prepare("SELECT status FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ status: RunStatus }>();
  return stored?.status;
}

async function failRun(
  db: D1Database,
  runId: string,
  code: string,
  finishedAt: number,
) {
  const failed = await db
    .prepare(
      "UPDATE runs SET status = 'failed', error_code = ?, finished_at = ?, next_action_at = NULL WHERE id = ? AND status = 'running' RETURNING status",
    )
    .bind(code, finishedAt, runId)
    .first<{ status: "failed" }>();
  return failed?.status ?? readRunStatus(db, runId);
}

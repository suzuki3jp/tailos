import type { D1Database } from "@cloudflare/workers-types";
import {
  executionContextSchema,
  type RunnerEvent,
  type RunnerJob,
  type RunnerStatus,
} from "@meguri/core/runner";
import * as v from "valibot";
import { writeRunArtifacts, type RunArtifactsBucket } from "./run-artifacts.ts";

type RunStatus = "queued" | "running" | "succeeded" | "failed";
type RunInput = {
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
      errorCode:
        | "runner_unavailable"
        | "invalid_execution_context"
        | "artifact_write_failed";
      events?: RunnerEvent[];
    };

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function executeRun(
  db: D1Database,
  runId: string,
  dispatch: (job: RunnerJob) => Promise<RunOutcome>,
  artifacts?: RunArtifactsBucket,
): Promise<RunStatus | undefined> {
  const run = await db
    .prepare(
      `UPDATE runs SET status = 'running' WHERE id = ? AND status = 'queued'
     RETURNING id, session_id AS sessionId, start_message_id AS messageId,
               execution_context AS executionContext, deadline_at AS deadlineAt`,
    )
    .bind(runId)
    .first<RunInput>();
  if (!run) return readRunStatus(db, runId);

  const message = await db
    .prepare("SELECT body FROM session_messages WHERE id = ?")
    .bind(run.messageId)
    .first<{ body: string }>();
  const context = v.safeParse(
    executionContextSchema,
    parseJson(run.executionContext),
  );
  let outcome: RunOutcome;
  if (run.deadlineAt <= Date.now()) {
    outcome = { status: "failed", errorCode: "deadline_exceeded", events: [] };
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
          "UPDATE runs SET status = 'succeeded', result = ?, finished_at = ? WHERE id = ? AND status = 'running'",
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
      "UPDATE runs SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ? AND status = 'running' RETURNING status",
    )
    .bind(code, finishedAt, runId)
    .first<{ status: "failed" }>();
  return failed?.status ?? readRunStatus(db, runId);
}

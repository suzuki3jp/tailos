import type { D1Database } from "@cloudflare/workers-types";
import {
  advanceRun as execute,
  type RunInput,
  type RunStatus,
  type RunStore,
} from "@/application/runs/advance-run.ts";
import {
  writeRunArtifacts,
  type RunArtifactsBucket,
} from "@/infrastructure/r2/run-artifacts.ts";
import {
  ensureRunTrace,
  executionTransition,
} from "@/infrastructure/diagnostics/journal.ts";

function d1RunStore(db: D1Database): RunStore {
  return {
    async claim(runId: string, now: number) {
      const results = await db.batch<RunInput>([
        ...ensureRunTrace(db, runId, now),
        executionTransition(db, runId, "queued", "running", now),
        db
          .prepare(
            `UPDATE runs SET status = 'running', next_action_at = ?
     WHERE id = ? AND status = 'queued'
     RETURNING start_message_id AS messageId, execution_context AS executionContext,
               deadline_at AS deadlineAt, step_state AS stepState`,
          )
          .bind(now, runId),
      ]);
      return results.at(-1)?.results[0] ?? null;
    },
    load(runId: string) {
      return db
        .prepare(
          `SELECT start_message_id AS messageId, execution_context AS executionContext,
            deadline_at AS deadlineAt, step_state AS stepState FROM runs WHERE id = ? AND status = 'running'`,
        )
        .bind(runId)
        .first<RunInput>();
    },
    async schedule(runId: string, nextActionAt: number) {
      await db
        .prepare(
          "UPDATE runs SET next_action_at = ? WHERE id = ? AND status = 'running'",
        )
        .bind(nextActionAt, runId)
        .run();
    },
    readMessage(messageId: string) {
      return db
        .prepare("SELECT body FROM session_messages WHERE id = ?")
        .bind(messageId)
        .first<{ body: string }>();
    },
    async complete(
      runId: string,
      reply: string,
      result: string,
      finishedAt: number,
    ) {
      const [, , update] = await db.batch([
        executionTransition(
          db,
          runId,
          "running",
          "succeeded",
          finishedAt,
          null,
          result,
        ),
        db
          .prepare(
            `INSERT INTO session_messages (id, session_id, seq, author_kind, body, run_id, created_at)
         SELECT ?, session_id, (SELECT coalesce(max(seq), 0) + 1 FROM session_messages
                               WHERE session_id = runs.session_id),
                'agent', ?, id, ? FROM runs WHERE id = ? AND status = 'running'`,
          )
          .bind(crypto.randomUUID(), reply, finishedAt, runId),
        db
          .prepare(
            "UPDATE runs SET status = 'succeeded', result = ?, finished_at = ?, next_action_at = NULL, step_state = json_remove(step_state, '$.pendingPublication') WHERE id = ? AND status = 'running' RETURNING id",
          )
          .bind(result, finishedAt, runId),
      ]);
      return update?.results.length === 1;
    },
    async readStatus(runId: string) {
      const stored = await db
        .prepare("SELECT status FROM runs WHERE id = ?")
        .bind(runId)
        .first<{ status: RunStatus }>();
      return stored?.status;
    },
    async fail(
      runId: string,
      code: string,
      finishedAt: number,
      result: string | null = null,
    ) {
      const [, failed] = await db.batch<{ status: "failed" }>([
        executionTransition(
          db,
          runId,
          "running",
          "failed",
          finishedAt,
          code,
          result,
        ),
        db
          .prepare(
            "UPDATE runs SET status = 'failed', error_code = ?, finished_at = ?, result = ?, next_action_at = NULL, step_state = json_remove(step_state, '$.pendingPublication') WHERE id = ? AND status = 'running' RETURNING status",
          )
          .bind(code, finishedAt, result, runId),
      ]);
      return failed?.results[0]?.status;
    },
  };
}

export function advanceRun(
  db: D1Database,
  runId: string,
  driver: Parameters<typeof execute>[2],
  bucket?: RunArtifactsBucket,
) {
  return execute(
    d1RunStore(db),
    runId,
    driver,
    bucket && ((...args) => writeRunArtifacts(bucket, ...args)),
  );
}

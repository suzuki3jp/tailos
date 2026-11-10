import type { D1Database } from "@cloudflare/workers-types";
import {
  advanceRun as execute,
  type RunInput,
  type RunStatus,
  type RunStore,
} from "#api/application/runs/advance-run.ts";
import {
  writeRunArtifacts,
  type RunArtifactsBucket,
} from "#api/infrastructure/r2/run-artifacts.ts";

function d1RunStore(db: D1Database): RunStore {
  return {
    claim(runId: string, now: number) {
      return db
        .prepare(
          `UPDATE runs SET status = 'running', next_action_at = ?
     WHERE id = ? AND status = 'queued'
     RETURNING start_message_id AS messageId, execution_context AS executionContext,
               deadline_at AS deadlineAt, step_state AS stepState`,
        )
        .bind(now, runId)
        .first<RunInput>();
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
      const [, update] = await db.batch([
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
            "UPDATE runs SET status = 'succeeded', result = ?, finished_at = ?, next_action_at = NULL, step_state = json_remove(step_state, '$.pendingPublication') WHERE id = ? AND status = 'running'",
          )
          .bind(result, finishedAt, runId),
      ]);
      return update?.meta.changes === 1;
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
      const failed = await db
        .prepare(
          "UPDATE runs SET status = 'failed', error_code = ?, finished_at = ?, result = ?, next_action_at = NULL, step_state = json_remove(step_state, '$.pendingPublication') WHERE id = ? AND status = 'running' RETURNING status",
        )
        .bind(code, finishedAt, result, runId)
        .first<{ status: "failed" }>();
      return failed?.status;
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

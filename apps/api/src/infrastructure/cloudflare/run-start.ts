import type { Bindings } from "@/bindings.ts";

type RunnerEnv = Pick<Bindings, "DB" | "RUNNER">;

/** The Session of a Run, which names the Runner that processes its Turns. */
export async function runSession(db: RunnerEnv["DB"], runId: string) {
  const run = await db
    .prepare("SELECT session_id AS sessionId FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ sessionId: string }>();
  return run?.sessionId ?? null;
}

/** Schedules a Run on its Session's Runner: a Session's Turns share one. */
export function runStarter(env: RunnerEnv) {
  const runner = env.RUNNER;
  if (!runner) return undefined;
  return async (runId: string) => {
    const sessionId = await runSession(env.DB, runId);
    if (!sessionId) throw new Error("Run has no Session");
    await runner.getByName(sessionId).schedule(runId, sessionId);
  };
}

import { listDueRunIds } from "@/infrastructure/d1/run-recovery.ts";
import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import app from "@/bootstrap/http.ts";
import type { Bindings } from "@/bindings.ts";
import { rescheduleDueRuns } from "@/application/runs/recovery.ts";
import { observeRun } from "@/infrastructure/diagnostics/store.ts";

export { CredentialBroker } from "@/infrastructure/cloudflare/credential-broker.ts";
export { RunnerContainer } from "@/infrastructure/cloudflare/runner-container.ts";

export default {
  fetch: app.fetch,
  scheduled(
    _controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ) {
    const runner = env.RUNNER;
    if (!runner) throw new Error("Missing runner binding");
    ctx.waitUntil(
      rescheduleDueRuns(
        (now) => listDueRunIds(env.DB, now),
        (id) =>
          observeRun(env.DB, id, "recovery", () =>
            runner.getByName(id).schedule(id),
          ),
      ),
    );
    ctx.waitUntil(runner.getByName("diagnostics-cleanup").cleanupDiagnostics());
  },
};

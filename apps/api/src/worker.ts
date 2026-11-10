import { listDueRunIds } from "#api/infrastructure/d1/run-recovery.ts";
import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import app from "#api/bootstrap/http.ts";
import type { Bindings } from "#api/bindings.ts";
import { rescheduleDueRuns } from "#api/application/runs/recovery.ts";

export { CredentialBroker } from "#api/infrastructure/cloudflare/credential-broker.ts";
export { RunnerContainer } from "#api/infrastructure/cloudflare/runner-container.ts";

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
        (id) => runner.getByName(id).schedule(id),
      ),
    );
  },
};

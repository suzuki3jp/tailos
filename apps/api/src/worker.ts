import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import app from "./index.ts";
import type { Bindings } from "./internal.ts";
import { rescheduleDueRuns } from "./run-scheduler.ts";

export { CredentialBroker } from "./auth/credential-broker.ts";
export { RunnerContainer } from "./runner-container.ts";

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
      rescheduleDueRuns(env.DB, (id) => runner.getByName(id).schedule(id)),
    );
  },
};

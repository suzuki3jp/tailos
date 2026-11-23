import { processPlanningInputs } from "@/bootstrap/planning.ts";
import { deliverIssueNotifications } from "@/bootstrap/issue-notifications.ts";
import { listDueRunIds } from "@/infrastructure/d1/run-recovery.ts";
import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import app, { browserProxy } from "@/bootstrap/http.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "@/bindings.ts";
import { rescheduleDueRuns } from "@/application/runs/recovery.ts";
import { observeRun } from "@/infrastructure/diagnostics/store.ts";
import { deliverTimelineNotifications } from "@/infrastructure/cloudflare/session-stream.ts";
import { expireTimeline } from "@/infrastructure/d1/timeline.ts";
import { runStarter } from "@/infrastructure/cloudflare/run-start.ts";

export { CredentialBroker } from "@/infrastructure/cloudflare/credential-broker.ts";
export { GitHubEgress } from "@/infrastructure/cloudflare/github-egress.ts";
export { ModelEgress } from "@/infrastructure/cloudflare/model-egress.ts";
export { RunnerContainer } from "@/infrastructure/cloudflare/runner-container.ts";
export { SessionStream } from "@/infrastructure/cloudflare/session-stream.ts";

// Only the Web Worker binds to this entrypoint for browser and SSR requests.
export class BrowserApiProxy extends WorkerEntrypoint<Bindings> {
  fetch(request: Request) {
    if (
      this.env.TAILOS_BROWSER_API_VIA_WEB !== "true" ||
      new URL(request.url).origin !== this.env.TAILOS_WEB_ORIGIN
    ) {
      return new Response(null, { status: 404 });
    }
    return browserProxy.fetch(request, this.env, this.ctx);
  }
}

export default {
  fetch: app.fetch,
  scheduled(
    _controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(deliverIssueNotifications(env));
    ctx.waitUntil(processPlanningInputs(env));
    ctx.waitUntil(deliverTimelineNotifications(env));
    ctx.waitUntil(expireTimeline(env.DB));
    const runner = env.RUNNER;
    const schedule = runStarter(env);
    if (!runner || !schedule) throw new Error("Missing runner binding");
    ctx.waitUntil(
      rescheduleDueRuns(
        (now) => listDueRunIds(env.DB, now),
        (id) => observeRun(env.DB, id, "recovery", () => schedule(id)),
      ),
    );
    ctx.waitUntil(runner.getByName("diagnostics-cleanup").cleanupDiagnostics());
  },
};

import { DurableObject } from "cloudflare:workers";
import { runnerStatusSchema, type RunnerJob } from "@meguri/core/runner";
import * as v from "valibot";
import type { Bindings } from "../../bindings.ts";
import { advanceRun } from "../d1/run-execution.ts";
import { type RunnerDriver } from "../../application/runs/advance-run.ts";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

export class RunnerContainer extends DurableObject<Bindings> {
  async checkHealth(): Promise<boolean> {
    try {
      await this.startRunner(Date.now() + 15_000);
      return true;
    } finally {
      await this.ctx.container?.destroy().catch(() => {
        // oxlint-disable-next-line no-console -- Record cleanup failures without container data.
        console.warn("Runner health check container cleanup failed");
      });
    }
  }

  async schedule(runId: string): Promise<void> {
    await this.ctx.storage.put("runId", runId);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const runId = await this.ctx.storage.get<string>("runId");
    if (!runId) return;

    const driver: RunnerDriver = {
      start: (job) => this.submitJob(job),
      poll: (id) => this.pollJob(id),
    };
    const progress = await advanceRun(
      this.env.DB,
      runId,
      driver,
      this.env.RUN_ARTIFACTS,
    );
    if (progress?.status === "running") {
      await this.ctx.storage.setAlarm(progress.nextActionAt);
      return;
    }

    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }

  private async startRunner(deadlineAt: number) {
    const container = this.ctx.container;
    const image = container?.images.runner;
    if (!container || !image) throw new Error("Runner binding unavailable");

    container.start({ image, instance: "lite", enableInternet: false });
    await container.setInactivityTimeout(
      Math.max(30_000, deadlineAt - Date.now() + 30_000),
    );
    const startupDeadline = Math.min(deadlineAt, Date.now() + 15_000);
    while (Date.now() < startupDeadline) {
      try {
        const port = container.getTcpPort(8080);
        const response = await port.fetch("http://runner/health", {
          signal: AbortSignal.timeout(
            Math.max(0, Math.min(1_000, startupDeadline - Date.now())),
          ),
        });
        const body: unknown = await response.json();
        if (
          response.ok &&
          typeof body === "object" &&
          body !== null &&
          "status" in body &&
          body.status === "ok" &&
          "service" in body &&
          body.service === "runner"
        )
          return port;
      } catch {
        // The process may not have opened its port yet.
      }
      await pause();
    }
    throw new Error("Runner readiness check timed out");
  }

  private async submitJob(job: RunnerJob) {
    const port = await this.startRunner(job.deadlineAt);
    const response = await port.fetch("http://runner/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(
        Math.max(0, Math.min(3_000, job.deadlineAt - Date.now())),
      ),
    });
    await response.body?.cancel();
    if (response.status !== 202) {
      return { status: "failed", errorCode: "runner_unavailable" } as const;
    }
    return { status: "running" } as const;
  }

  private async pollJob(runId: string) {
    const container = this.ctx.container;
    if (!container?.running)
      return { status: "failed", errorCode: "runner_lost" } as const;

    const reply = await container
      .getTcpPort(8080)
      .fetch(`http://runner/job/${runId}`, {
        signal: AbortSignal.timeout(3_000),
      });
    if (reply.status === 404) {
      await reply.body?.cancel();
      return { status: "failed", errorCode: "runner_lost" } as const;
    }
    if (!reply.ok) {
      await reply.body?.cancel();
      throw new Error("Runner status unavailable");
    }
    return v.parse(runnerStatusSchema, await reply.json());
  }
}

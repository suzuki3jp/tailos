import { DurableObject } from "cloudflare:workers";
import { runnerStatusSchema, type RunnerJob } from "@meguri/core/runner";
import * as v from "valibot";
import type { Bindings } from "./internal.ts";
import { executeRun } from "./run-execution.ts";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

export class RunnerContainer extends DurableObject<Bindings> {
  async checkHealth(): Promise<boolean> {
    try {
      await this.startRunner(Date.now() + 15_000);
      return true;
    } finally {
      await this.ctx.container?.destroy();
    }
  }

  async execute(runId: string) {
    return executeRun(this.env.DB, runId, async (job) => {
      try {
        return await this.runJob(job);
      } finally {
        await this.ctx.container?.destroy().catch(() => {
          console.warn(
            "Runner cleanup failed; inactivity timeout remains in effect",
          );
        });
      }
    });
  }

  private async startRunner(deadlineAt: number) {
    const container = this.ctx.container;
    const image = container?.images.runner;
    if (!container || !image) throw new Error("Runner binding unavailable");

    container.start({ image, instance: "lite", enableInternet: false });
    await container.setInactivityTimeout(30_000);
    const startupDeadline = Math.min(deadlineAt, Date.now() + 15_000);
    while (Date.now() < startupDeadline) {
      try {
        const port = container.getTcpPort(8080);
        const response = await port.fetch("http://runner/health", {
          signal: AbortSignal.timeout(
            Math.min(1_000, startupDeadline - Date.now()),
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

  private async runJob(job: RunnerJob) {
    const port = await this.startRunner(job.deadlineAt);
    const signal = AbortSignal.timeout(
      Math.max(0, job.deadlineAt - Date.now()),
    );
    const response = await port.fetch("http://runner/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
      signal,
    });
    if (response.status !== 202)
      throw new Error("Runner did not accept the job");
    await response.body?.cancel();

    while (!signal.aborted) {
      const reply = await port.fetch(`http://runner/job/${job.runId}`, {
        signal,
      });
      if (!reply.ok) throw new Error("Runner status unavailable");
      const status = v.parse(runnerStatusSchema, await reply.json());
      if (status.status !== "running") return status;
      await pause();
    }
    return { status: "failed", errorCode: "deadline_exceeded" } as const;
  }
}

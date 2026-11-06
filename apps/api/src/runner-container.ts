import {
  pendingPublication,
  type PendingPublication,
} from "./github/publication.ts";
import { GitHubApp } from "./github/app.ts";
import { seal, unseal, type Sealed } from "./auth/sealed-store.ts";
import { hashRunLease, matchRunLease, newRunLease } from "./auth/run-lease.ts";
import { DurableObject } from "cloudflare:workers";
import {
  runnerStatusSchema,
  type ExecutionContext,
  type RunnerJob,
  type RepositoryTarget,
} from "@meguri/core/runner";
import * as v from "valibot";
import type { Bindings } from "./internal.ts";
import {
  advanceRun,
  type RunnerDriver,
  type RunRequest,
} from "./run-execution.ts";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

type RepositoryGrant = {
  value: Sealed;
  expiresAt: number;
  attempts: number;
};

type RefreshLease = {
  digest: string;
  runId: string;
  connectionId: string;
  connectionVersion: string;
  expiresAt: number;
  lastRefreshAt: number;
};

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
      poll: (id, context, deadlineAt, stepState) =>
        this.pollJob(id, context, deadlineAt, stepState),
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

    await this.ctx.storage.delete("refreshLease");
    try {
      if (this.ctx.container?.running) await this.ctx.container.destroy();
    } finally {
      await this.revokeRepositoryGrant(runId);
    }
  }

  private async startRunner(deadlineAt: number, enableInternet = false) {
    const container = this.ctx.container;
    const image = container?.images.runner;
    if (!container || !image) throw new Error("Runner binding unavailable");

    container.start({
      image,
      instance: enableInternet ? "standard-1" : "lite",
      enableInternet,
    });
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

  async refreshAccess(runId: string, bearer: string, accessVersion: string) {
    const digest = await hashRunLease(bearer);
    const active = await this.env.DB.prepare(
      "SELECT 1 AS active FROM runs WHERE id = ? AND status = 'running' AND deadline_at > ?",
    )
      .bind(runId, Date.now())
      .first();
    if (!active) return null;

    const lease = await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<RefreshLease>("refreshLease");
      const now = Date.now();
      if (
        !current ||
        current.runId !== runId ||
        current.expiresAt <= now ||
        !matchRunLease(digest, current.digest) ||
        now - current.lastRefreshAt < 5_000
      )
        return null;
      await storage.put("refreshLease", { ...current, lastRefreshAt: now });
      return current;
    });
    if (!lease) return null;

    return this.env.CREDENTIALS?.getByName(lease.connectionId).issueAccess({
      accessVersion,
      connectionVersion: lease.connectionVersion,
    });
  }

  private async prepareJob(request: RunRequest): Promise<RunnerJob | null> {
    const { runId, prompt, deadlineAt, context } = request;
    const base = { version: 1 as const, runId, prompt, deadlineAt };
    if (context.engine === "fake") return { ...base, engine: "fake" };

    const origin = this.env.MEGURI_PUBLIC_ORIGIN;
    if (!origin || !this.env.CREDENTIALS) return null;
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) return null;

    const access = await this.env.CREDENTIALS.getByName(
      context.connectionId,
    ).issueAccess();
    if (!access) return null;
    const bearer = newRunLease();
    await this.ctx.storage.put("refreshLease", {
      digest: await hashRunLease(bearer),
      runId,
      connectionId: context.connectionId,
      connectionVersion: access.connectionVersion,
      expiresAt: deadlineAt,
      lastRefreshAt: 0,
    } satisfies RefreshLease);

    return {
      ...base,
      engine: "codex",
      access,
      refresh: { url: origin + `/_runner/runs/${runId}/credentials`, bearer },
    };
  }

  private get github() {
    const appId = this.env.MEGURI_GH_APP_ID;
    const privateKey = this.env.MEGURI_GH_APP_PRIVATE_KEY;
    return appId && privateKey ? new GitHubApp({ appId, privateKey }) : null;
  }

  private async revokeRepositoryGrant(runId: string) {
    const grant =
      await this.ctx.storage.get<RepositoryGrant>("repositoryGrant");
    if (!grant) return;
    if (grant.expiresAt <= Date.now()) {
      await this.ctx.storage.delete("repositoryGrant");
      return;
    }

    try {
      const key = this.env.CREDENTIAL_ENCRYPTION_KEY;
      const github = this.github;
      if (!key || !github) throw new Error("Repository revocation unavailable");
      const token = v.parse(
        v.string(),
        await unseal(grant.value, key, `meguri:github:${runId}`),
      );
      await github.revoke(token);
    } catch {
      if (grant.attempts < 4) {
        await this.ctx.storage.put("repositoryGrant", {
          ...grant,
          attempts: grant.attempts + 1,
        });
        await this.ctx.storage.setAlarm(
          Math.min(grant.expiresAt, Date.now() + 15_000),
        );
        return;
      }
      // oxlint-disable-next-line no-console -- Record revocation exhaustion without token data.
      console.warn("Repository grant revocation failed; relying on expiry");
    }
    await this.ctx.storage.delete("repositoryGrant");
  }

  private async submitJob(request: RunRequest) {
    const job = await this.prepareJob(request).catch(() => null);
    if (!job)
      return { status: "failed", errorCode: "provider_unavailable" } as const;

    const target =
      request.context.engine === "codex"
        ? request.context.repository
        : undefined;
    if (target && job.engine === "codex") {
      const github = this.github;
      const key = this.env.CREDENTIAL_ENCRYPTION_KEY;
      if (!github || !key)
        return {
          status: "failed",
          errorCode: "repository_unavailable",
        } as const;
      const checkout = await github
        .checkout(target, request.runId)
        .catch(() => null);
      if (!checkout)
        return {
          status: "failed",
          errorCode: "repository_unavailable",
        } as const;
      try {
        await this.ctx.storage.put("repositoryGrant", {
          value: await seal(
            checkout.token,
            key,
            `meguri:github:${request.runId}`,
          ),
          expiresAt: checkout.expiresAt,
          attempts: 0,
        } satisfies RepositoryGrant);
        await this.env.DB.prepare(
          "UPDATE runs SET step_state = ? WHERE id = ? AND status = 'running'",
        )
          .bind(
            JSON.stringify({
              version: 1,
              baseSha: checkout.baseSha,
              branch: checkout.branch,
            }),
            request.runId,
          )
          .run();
      } catch {
        await github.revoke(checkout.token).catch(() => {});
        return {
          status: "failed",
          errorCode: "repository_unavailable",
        } as const;
      }
      job.checkout = {
        repository: target.repository,
        baseSha: checkout.baseSha,
        branch: checkout.branch,
        token: checkout.token,
      };
    }
    const port = await this.startRunner(job.deadlineAt, job.engine === "codex");
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

  private async pollJob(
    runId: string,
    context: ExecutionContext,
    deadlineAt: number,
    stepState: string | null,
  ) {
    const target = context.engine === "codex" ? context.repository : undefined;
    const pending = target ? pendingPublication(stepState) : null;
    if (target && pending)
      return this.publish(runId, target, deadlineAt, pending);

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
    const status = v.parse(runnerStatusSchema, await reply.json());
    if (status.status !== "succeeded" || !target) return status;
    if (!status.publication)
      return { status: "failed", errorCode: "repository_unavailable" } as const;
    if (status.publication.kind === "no_changes") {
      return { ...status, publicationResult: { kind: "no_changes" as const } };
    }

    const pendingWork = {
      reply: status.reply,
      events: status.events,
      ...status.publication,
    };
    await this.env.DB.prepare(
      `UPDATE runs SET step_state = json_set(coalesce(step_state, '{}'), '$.pendingPublication', json(?))
       WHERE id = ? AND status = 'running'`,
    )
      .bind(JSON.stringify(pendingWork), runId)
      .run();
    return this.publish(runId, target, deadlineAt, pendingWork);
  }

  private async publish(
    runId: string,
    target: RepositoryTarget,
    deadlineAt: number,
    work: PendingPublication,
  ) {
    const github = this.github;
    if (!github)
      return {
        status: "failed",
        errorCode: "publication_unconfirmed",
      } as const;
    const url = await github.publish(target, runId, work, deadlineAt);
    if (!url)
      return {
        status: "failed",
        errorCode: "deadline_exceeded",
        events: work.events,
      } as const;
    return {
      status: "succeeded" as const,
      reply: work.reply,
      events: work.events,
      publicationResult: {
        kind: "pull_request" as const,
        url,
        branch: work.branch,
        sha: work.sha,
      },
    };
  }
}

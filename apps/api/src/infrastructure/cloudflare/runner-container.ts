import {
  beginPublicationReconciliation,
  stageRunPublication,
} from "@/infrastructure/d1/run-publication.ts";
import {
  pendingPublication,
  publicationDeadline,
  type LegacyPublication,
  type PendingPublication,
} from "@/application/runs/publication.ts";
import { GitHubApp } from "@/infrastructure/github/app.ts";
import {
  seal,
  unseal,
  type Sealed,
} from "@/infrastructure/auth/sealed-store.ts";
import {
  hashRunLease,
  matchRunLease,
  newRunLease,
} from "@/infrastructure/auth/run-lease.ts";
import { DurableObject } from "cloudflare:workers";
import {
  fileChangesSchema,
  runnerStatusSchema,
  type CheckedPublication,
  type ExecutionContext,
  type RunnerJob,
  type RepositoryTarget,
} from "@tailos/core/runner";
import * as v from "valibot";
import type { Bindings } from "@/bindings.ts";
import { advanceRun } from "@/infrastructure/d1/run-execution.ts";
import {
  type RunnerDriver,
  type RunRequest,
} from "@/application/runs/advance-run.ts";

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

const publicationKey = (runId: string, digest: string) =>
  `tailos-api/v1/runs/${runId}/publication-${digest}.json`;

async function publicationDigest(content: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Buffer.from(bytes).toString("hex");
}

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
    const digest = await this.ctx.storage.get<string>("publicationDigest");
    if (digest && this.env.RUN_ARTIFACTS?.delete) {
      try {
        await this.env.RUN_ARTIFACTS.delete(publicationKey(runId, digest));
        await this.ctx.storage.delete("publicationDigest");
      } catch {
        // oxlint-disable-next-line no-console -- Record cleanup failures without artifact data.
        console.warn("Checked publication cleanup failed", { runId });
      }
    }
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

  async stagePublication(
    runId: string,
    bearer: string,
    work: CheckedPublication | LegacyPublication,
  ) {
    const lease = await this.ctx.storage.get<RefreshLease>("refreshLease");
    if (
      !lease ||
      lease.runId !== runId ||
      lease.expiresAt <= Date.now() ||
      !matchRunLease(await hashRunLease(bearer), lease.digest)
    )
      return false;
    if (work.kind !== "checked")
      return stageRunPublication(this.env.DB, runId, work);
    const assigned = await this.env.DB.prepare(
      `SELECT 1 FROM runs WHERE id = ? AND status = 'running' AND deadline_at > ?
       AND json_extract(step_state, '$.branch') = ?
       AND json_extract(step_state, '$.baseSha') = ?`,
    )
      .bind(runId, Date.now(), work.branch, work.baseSha)
      .first();
    if (!assigned) return false;
    const bucket = this.env.RUN_ARTIFACTS;
    if (!bucket) throw new Error("Checked publication storage unavailable");
    const { changes, ...checkpoint } = work;
    const content = JSON.stringify(changes);
    const digest = await publicationDigest(content);
    const reserved = await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<string>("publicationDigest");
      if (current) return current === digest;
      await storage.put("publicationDigest", digest);
      return true;
    });
    if (!reserved) return false;
    await bucket.put(publicationKey(runId, digest), content);
    const staged = await stageRunPublication(this.env.DB, runId, {
      ...checkpoint,
      digest,
    });
    if (!staged) {
      const running = await this.env.DB.prepare(
        "SELECT 1 FROM runs WHERE id = ? AND status = 'running'",
      )
        .bind(runId)
        .first();
      if (!running) await bucket.delete?.(publicationKey(runId, digest));
    }
    return staged;
  }

  private async prepareJob(request: RunRequest): Promise<RunnerJob | null> {
    const { runId, prompt, deadlineAt, context } = request;
    const base = { version: 1 as const, runId, prompt, deadlineAt };
    if (context.engine === "fake") return { ...base, engine: "fake" };

    const origin = this.env.TAILOS_PUBLIC_ORIGIN;
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
    const appId = this.env.TAILOS_GH_APP_ID;
    const privateKey = this.env.TAILOS_GH_APP_PRIVATE_KEY;
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
        await unseal(grant.value, key, `tailos:github:${runId}`),
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
            `tailos:github:${request.runId}`,
          ),
          expiresAt: checkout.expiresAt,
          attempts: 0,
        } satisfies RepositoryGrant);
        await this.env.DB.prepare(
          "UPDATE runs SET step_state = ? WHERE id = ? AND status = 'running'",
        )
          .bind(
            JSON.stringify({
              version: 2,
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
    if (target && pending?.kind === "checked") {
      const recoveryDeadline = publicationDeadline(stepState, deadlineAt);
      const github = this.github;
      if (!github) throw new Error("GitHub verification unavailable");
      const object = await this.env.RUN_ARTIFACTS?.get(
        publicationKey(runId, pending.digest),
      );
      const content = await object?.text();
      if (!content || (await publicationDigest(content)) !== pending.digest)
        throw new Error("Checked publication unavailable");
      const changes = v.parse(fileChangesSchema, JSON.parse(content));
      const sha = await github.commitCheckedWork(
        target,
        runId,
        { ...pending, changes },
        recoveryDeadline,
      );
      if (!sha)
        return {
          status: "failed",
          errorCode: "publication_unconfirmed",
          events: pending.events,
        } as const;
      return this.publish(runId, target, recoveryDeadline, pending, sha);
    }
    if (target && pending?.kind === "pushed")
      return this.publish(
        runId,
        target,
        publicationDeadline(stepState, deadlineAt),
        pending,
      );

    const status = await this.readRunnerStatus(runId).catch(
      (error: unknown) => {
        if (!pending || Date.now() < deadlineAt) throw error;
        // Once Agent time is over, a failed status request must not skip the
        // remote-ref check for a push whose response may have been lost.
        return { status: "failed", errorCode: "runner_lost" } as const;
      },
    );
    if (target && pending && pending.kind !== "checked") {
      if (status.status === "running" && Date.now() < deadlineAt) return status;
      if (
        !(await beginPublicationReconciliation(
          this.env.DB,
          runId,
          pending,
          false,
        ))
      )
        throw new Error("Publication checkpoint changed");

      const pushed =
        status.status === "succeeded" &&
        status.publication?.kind === "pushed" &&
        status.publication.branch === pending.branch &&
        status.publication.sha === pending.sha;
      if (!pushed) {
        const github = this.github;
        if (!github) throw new Error("GitHub verification unavailable");
        if (!(await github.hasCommit(target, runId, pending))) {
          return status.status === "failed"
            ? status
            : ({
                status: "failed",
                errorCode: "repository_unavailable",
              } as const);
        }
      }
      if (
        !(await beginPublicationReconciliation(
          this.env.DB,
          runId,
          pending,
          true,
        ))
      )
        throw new Error("Publication checkpoint changed");
      return { status: "running" } as const;
    }
    if (status.status !== "succeeded" || !target) return status;
    if (!status.publication)
      return { status: "failed", errorCode: "repository_unavailable" } as const;
    if (status.publication.kind === "no_changes") {
      return { ...status, publicationResult: { kind: "no_changes" as const } };
    }

    if (status.publication.kind !== "pushed")
      return {
        status: "failed",
        errorCode: "publication_unconfirmed",
      } as const;

    const pendingWork = {
      reply: status.reply,
      events: status.events,
      ...status.publication,
    };
    // An older Runner may report a pushed commit without a checkpoint.
    if (
      !(await stageRunPublication(this.env.DB, runId, pendingWork)) ||
      !(await beginPublicationReconciliation(
        this.env.DB,
        runId,
        pendingWork,
        true,
      ))
    )
      return { status: "failed", errorCode: "repository_unavailable" } as const;
    return { status: "running" } as const;
  }

  private async readRunnerStatus(runId: string) {
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

  private async publish(
    runId: string,
    target: RepositoryTarget,
    deadlineAt: number,
    work: PendingPublication,
    sha = work.kind === "checked" ? undefined : work.sha,
  ) {
    const github = this.github;
    if (!github || !sha)
      return {
        status: "failed",
        errorCode: "publication_unconfirmed",
      } as const;
    const publication =
      work.kind === "checked"
        ? { branch: work.branch, sha, headline: work.headline }
        : work;
    const url = await github.publish(target, runId, publication, deadlineAt);
    if (!url)
      return {
        status: "failed",
        errorCode: "publication_unconfirmed",
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
        sha,
      },
    };
  }
}

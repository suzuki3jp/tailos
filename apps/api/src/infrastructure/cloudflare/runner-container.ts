import {
  dispatchPlanningInputs,
  savePlanningSnapshot,
} from "@/infrastructure/d1/planning.ts";
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
  CodexModels,
  CodexModelsRequest,
  FileChanges,
  maxRunnerJobBytes,
  RunnerStatus,
  type CheckedPublication,
  type ExecutionContext,
  type RunnerJob,
  type RepositoryTarget,
  type CodexAccess,
} from "@tailos/core/runner";
import * as v from "valibot";
import type { Bindings } from "@/bindings.ts";
import { advanceRun } from "@/infrastructure/d1/run-execution.ts";
import {
  type RunnerDriver,
  type RunRequest,
} from "@/application/runs/advance-run.ts";
import {
  diagnosticBodyRetentionMs,
  diagnosticGraceMs,
  runTraceId,
  type DiagnosticBatch,
  type DiagnosticContext,
} from "@tailos/core/diagnostics";
import {
  expireDiagnostics,
  ingestDiagnostics,
  observeRun,
  recordRunDiagnostic,
  registerDiagnosticProducer,
} from "@/infrastructure/diagnostics/store.ts";
import { DiagnosticStorageLimit } from "@/application/diagnostics/store.ts";
import { deliverTimelineNotifications } from "./session-stream.ts";

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
type DiagnosticLease = {
  digest: string;
  runId: string;
  producerId: string;
  expiresAt: number;
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
  private pollUnavailable = false;
  async cleanupDiagnostics() {
    await expireDiagnostics(this.env.DB, this.env.RUN_ARTIFACTS);
    const bucket = this.env.RUN_ARTIFACTS;
    if (!bucket?.list || !bucket.delete) return;
    const cursor = await this.ctx.storage.get<string>(
      "diagnosticCleanupCursor",
    );
    const page = await bucket.list({
      prefix: "diagnostics/v1/",
      limit: 100,
      cursor,
    });
    for (const object of page.objects) {
      if (object.uploaded.getTime() + diagnosticBodyRetentionMs <= Date.now())
        await bucket.delete(object.key);
    }
    if (page.truncated && page.cursor)
      await this.ctx.storage.put("diagnosticCleanupCursor", page.cursor);
    else await this.ctx.storage.delete("diagnosticCleanupCursor");
  }
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

  async codexModels(access: CodexAccess) {
    try {
      const port = await this.startRunner(Date.now() + 15_000, true);
      const response = await port.fetch("http://runner/codex/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v.parse(CodexModelsRequest, { access })),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return v.parse(CodexModels, await response.json());
    } finally {
      await this.ctx.container?.destroy().catch(() => {
        // oxlint-disable-next-line no-console -- Never include credentials in cleanup diagnostics.
        console.warn("Model catalog container cleanup failed");
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
      start: (job) =>
        observeRun(
          this.env.DB,
          runId,
          "runner",
          () => this.submitJob(job),
          (result) => (result.status === "failed" ? "failed" : "succeeded"),
        ),
      poll: async (id, context, deadlineAt, stepState) => {
        try {
          const result = await this.pollJob(id, context, deadlineAt, stepState);
          if (this.pollUnavailable) {
            this.pollUnavailable = false;
            await recordRunDiagnostic(
              this.env.DB,
              id,
              runTraceId(id),
              "runner.poll_recovered",
              { operation: "runner", outcome: result.status },
            );
          }
          return result;
        } catch (error) {
          if (!this.pollUnavailable) {
            this.pollUnavailable = true;
            await recordRunDiagnostic(
              this.env.DB,
              id,
              runTraceId(id),
              "runner.poll_failed",
              { operation: "runner", outcome: "unknown", reason: "transport" },
            );
          }
          throw error;
        }
      },
    };
    const progress = await advanceRun(
      this.env.DB,
      runId,
      driver,
      this.env.RUN_ARTIFACTS,
    );
    await deliverTimelineNotifications(this.env, runId).catch(() => {});
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
      const container = this.ctx.container;
      if (container?.running)
        await observeRun(this.env.DB, runId, "cleanup", () =>
          container.destroy(),
        );
    } finally {
      await this.revokeRepositoryGrant(runId);
      const next = await dispatchPlanningInputs(this.env.DB);
      await Promise.all(
        next.map((id) => this.env.RUNNER?.getByName(id).schedule(id)),
      );
    }
  }

  private async startRunner(deadlineAt: number, enableInternet = false) {
    const container = this.ctx.container;
    const image = container?.images.runner;
    if (!container || !image) throw new Error("Runner binding unavailable");

    container.start({
      image,
      instance: enableInternet ? "standard-3" : "lite",
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

  async ingestDiagnostics(
    runId: string,
    bearer: string,
    batch: DiagnosticBatch,
  ) {
    const lease =
      await this.ctx.storage.get<DiagnosticLease>("diagnosticLease");
    if (
      !lease ||
      lease.runId !== runId ||
      lease.producerId !== batch.producerId ||
      lease.expiresAt <= Date.now() ||
      !matchRunLease(await hashRunLease(bearer), lease.digest)
    )
      return false;
    if (!this.env.RUN_ARTIFACTS)
      throw new Error("Diagnostic storage unavailable");
    try {
      await ingestDiagnostics(
        this.env.DB,
        this.env.RUN_ARTIFACTS,
        runId,
        lease.producerId,
        batch,
        [bearer],
      );
    } catch (error) {
      if (error instanceof DiagnosticStorageLimit) return "limit" as const;
      throw error;
    }
    await deliverTimelineNotifications(this.env, runId).catch(() => {});
    if (batch.completed) {
      const active = await this.env.DB.prepare(
        "SELECT id FROM runs WHERE id = ? AND status = 'running'",
      )
        .bind(runId)
        .first();
      if (active)
        await this.ctx.storage.setAlarm(Date.now() + 250).catch(() => {});
    }
    return true;
  }

  private async diagnosticContext(
    runId: string,
    deadlineAt: number,
  ): Promise<DiagnosticContext | undefined> {
    const origin = this.env.TAILOS_PUBLIC_ORIGIN;
    if (
      !origin ||
      !this.env.RUN_ARTIFACTS ||
      new URL(origin).protocol !== "https:"
    )
      return undefined;
    const producerId = crypto.randomUUID();
    const bearer = newRunLease();
    const expiresAt = deadlineAt + diagnosticGraceMs;
    await registerDiagnosticProducer(this.env.DB, runId, producerId);
    await this.ctx.storage.put("diagnosticLease", {
      runId,
      producerId,
      expiresAt,
      digest: await hashRunLease(bearer),
    } satisfies DiagnosticLease);
    return {
      traceId: runTraceId(runId),
      parentSpanId: runTraceId(runId),
      producerId,
      url: origin + `/_runner/runs/${runId}/diagnostics`,
      bearer,
      expiresAt,
    };
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

    return observeRun(
      this.env.DB,
      runId,
      "refresh",
      async () =>
        this.env.CREDENTIALS?.getByName(lease.connectionId).issueAccess({
          accessVersion,
          connectionVersion: lease.connectionVersion,
        }),
      (result) => (result ? "succeeded" : "failed"),
    );
  }

  async stagePublication(
    runId: string,
    bearer: string,
    work: CheckedPublication | LegacyPublication,
  ) {
    const execution = await this.env.DB.prepare(
      "SELECT execution_context FROM runs WHERE id = ?",
    )
      .bind(runId)
      .first<{ execution_context: string }>();
    if (!execution || JSON.parse(execution.execution_context).mode === "plan")
      return false;
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
    const diagnostics = await this.diagnosticContext(runId, deadlineAt).catch(
      () => undefined,
    );
    const base = {
      version: 1 as const,
      ...(context.mode === "plan" && { mode: "plan" as const }),
      runId,
      prompt,
      deadlineAt,
      ...(diagnostics && { diagnostics }),
    };
    if (context.engine === "fake") return { ...base, engine: "fake" };
    // Claude connections cannot start a Run yet: there is nothing to issue.
    if (context.engine !== "codex") return null;

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
      ...(context.model && { model: context.model }),
      ...(context.effort && { effort: context.effort }),
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
      job.githubContext = {
        kind: "issue",
        number: target.issueNumber,
        ...(target.issueContentHash && {
          contentHash: target.issueContentHash,
        }),
      };
      const github = this.github;
      const key = this.env.CREDENTIAL_ENCRYPTION_KEY;
      if (!github || !key)
        return {
          status: "failed",
          errorCode: "repository_unavailable",
        } as const;
      const checkout = await github
        .checkout(target, request.runId, request.context.mode)
        .catch(() => null);
      if (!checkout)
        return {
          status: "failed",
          errorCode: "repository_unavailable",
        } as const;
      try {
        if (request.context.mode === "plan" && checkout.issueSnapshot) {
          const snapshot = await savePlanningSnapshot(
            this.env.DB,
            request.runId,
            checkout.issueSnapshot,
            checkout.baseSha,
          );
          if (snapshot) {
            checkout.baseSha = snapshot.baseSha;
            job.prompt = snapshot.prompt;
            job.planningContext = snapshot.context;
            job.githubContext.contentHash = snapshot.contentHash;
          }
        }
      } catch {
        await github.revoke(checkout.token).catch(() => {});
        return {
          status: "failed",
          errorCode: "planning_snapshot_failed",
        } as const;
      }
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
        agentNetworkAccess: target.agentNetworkAccess ?? false,
      };
    }
    if (
      job.mode === "plan" &&
      new TextEncoder().encode(JSON.stringify(job)).byteLength >
        maxRunnerJobBytes
    )
      return {
        status: "failed",
        errorCode: "planning_input_too_large",
      } as const;
    const port = await observeRun(this.env.DB, request.runId, "container", () =>
      this.startRunner(job.deadlineAt, job.engine === "codex"),
    );
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
    if (context.mode === "plan") {
      const status = await this.readRunnerStatus(runId);
      if (status.status !== "succeeded") return status;
      if (!status.plan || status.publication)
        return {
          status: "failed",
          errorCode: "agent_failed",
          events: status.events,
        } as const;
      return status;
    }
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
      const changes = v.parse(FileChanges, JSON.parse(content));
      const sha = await observeRun(
        this.env.DB,
        runId,
        "commit",
        () =>
          github.commitCheckedWork(
            target,
            runId,
            { ...pending, changes },
            recoveryDeadline,
          ),
        (result) => (result ? "succeeded" : "unknown"),
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
      ...(status.sessionTitle && { sessionTitle: status.sessionTitle }),
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
    return v.parse(RunnerStatus, await reply.json());
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
    const url = await observeRun(
      this.env.DB,
      runId,
      "pull_request",
      () => github.publish(target, runId, publication, deadlineAt),
      (result) => (result ? "succeeded" : "unknown"),
    );
    if (!url)
      return {
        status: "failed",
        errorCode: "publication_unconfirmed",
        events: work.events,
      } as const;
    return {
      status: "succeeded" as const,
      reply: work.reply,
      ...(work.sessionTitle && { sessionTitle: work.sessionTitle }),
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

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
  continuitySaveMs,
  FileChanges,
  maxContinuityBytes,
  maxRunnerJobBytes,
  RunnerStatus,
  type CheckedPublication,
  type ExecutionContext,
  type RunnerJob,
  type RepositoryTarget,
  type RunTrigger,
  triggerIssue,
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
import { runStarter } from "./run-start.ts";
import { githubEgressHosts, type GitHubEgressProps } from "./github-egress.ts";
import {
  codexEgressHosts,
  type ModelAccess,
  type ModelEgressProps,
} from "./model-egress.ts";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

type RepositoryGrant = {
  value: Sealed;
  expiresAt: number;
  attempts: number;
};

/** Authorizes the Runner's publication checkpoint and names the model connection. */
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

type RunnerExports = {
  GitHubEgress(options: { props: GitHubEgressProps }): Fetcher;
  ModelEgress(options: { props: ModelEgressProps }): Fetcher;
};

/**
 * Set once the Agent's work is over. Publication runs before the container is
 * destroyed, so the egress Workers must stop adding the Run's credentials
 * first: otherwise a process the Agent left behind could push to the work
 * branch or keep using the model connection.
 */
const agentEgressClosed = "agentEgressClosed";
/** The access version that the model API last rejected, forcing a refresh. */
const rejectedModelAccess = "rejectedModelAccess";
/** The shortest time between refreshes that a rejected token forces. */
const forcedRefreshInterval = 5_000;

/**
 * Stands in for the Codex access token inside the container. Codex reads the
 * account and plan claims; the model egress Worker replaces the whole token.
 */
export function placeholderAccessToken(
  accountId: string,
  planType: string | undefined,
  expiresAt: number,
) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      exp: Math.ceil(expiresAt / 1000),
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        ...(planType && { chatgpt_plan_type: planType }),
      },
    }),
    "tailos-placeholder",
  ].join(".");
}

/** Authorizes the Run's controller on the Runner's HTTP server. */
const runnerKeyStorage = "runnerKey";
/**
 * Where the Session's work stands for its next Turn: saved in R2 on top of
 * its base commit, or lost because the last Turn's work could not be saved.
 * It belongs to the Session, so it outlives each Run.
 */
type ContinuityRecord = { key: string; baseSha: string } | { lost: true };
const continuityStorage = "continuity";
/** The Run whose work is saved when it ends, and the base it works on. */
type ContinuityRun = { runId: string; baseSha: string };
const continuityRunStorage = "continuityRun";
const continuityKey = (sessionId: string, runId: string) =>
  `sessions/v1/${sessionId}/continuity/${runId}`;

/** Runs of this Session that wait for the current one to finish. */
const queuedRuns = "queuedRuns";
/**
 * Diagnostics leases outlive their Run for late telemetry, so each Run of the
 * Session has its own.
 */
const diagnosticLeasePrefix = "diagnosticLease/";
const diagnosticLeaseKey = (runId: string) => diagnosticLeasePrefix + runId;
/** What a Run leaves in storage, cleared before the next Run of the Session. */
const runStorage = [
  "runId",
  "refreshLease",
  rejectedModelAccess,
  runnerKeyStorage,
  agentEgressClosed,
  continuityRunStorage,
] as const;
const runnerHeaders = (key: string | undefined) =>
  key ? { Authorization: `Bearer ${key}` } : undefined;

const publicationKey = (runId: string, digest: string) =>
  `tailos-api/v1/runs/${runId}/publication-${digest}.json`;

async function publicationDigest(content: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Buffer.from(bytes).toString("hex");
}

/**
 * Processes the Turns of one Session, one at a time, in a container of its
 * own. The Durable Object is named after the Session; a Turn is a Run.
 */
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
      await this.startRunner(Date.now() + 15_000, "lite");
      return true;
    } finally {
      await this.ctx.container?.destroy().catch(() => {
        // oxlint-disable-next-line no-console -- Record cleanup failures without container data.
        console.warn("Runner health check container cleanup failed");
      });
    }
  }

  /**
   * Starts a Run of this Session, or queues it behind the Run in progress:
   * the container and its storage belong to one Run at a time.
   */
  async schedule(runId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      await storage.put("sessionId", sessionId);
      const current = await storage.get<string>("runId");
      if (!current) await storage.put("runId", runId);
      else if (current !== runId) {
        const queue = (await storage.get<string[]>(queuedRuns)) ?? [];
        if (!queue.includes(runId))
          await storage.put(queuedRuns, [...queue, runId]);
      }
    });
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
      // Keep the Turn's work for the Session before the container goes.
      const continuing =
        await this.ctx.storage.get<ContinuityRun>(continuityRunStorage);
      if (continuing?.runId === runId && container?.running)
        await this.saveContinuity(container, continuing).catch(() => {
          // oxlint-disable-next-line no-console -- Record save failures without work data.
          console.warn("Saving the Session's work failed", { runId });
        });
      if (container?.running)
        await observeRun(this.env.DB, runId, "cleanup", () =>
          container.destroy(),
        );
    } finally {
      // A revocation that will be retried keeps the Run current until then.
      if (await this.revokeRepositoryGrant(runId)) await this.finishRun();
      const next = await dispatchPlanningInputs(this.env.DB);
      const schedule = runStarter(this.env);
      if (schedule) await Promise.all(next.map((id) => schedule(id)));
    }
  }

  /** Clears what the finished Run left and starts the next queued Run. */
  private async finishRun() {
    const now = Date.now();
    const leases = await this.ctx.storage.list<DiagnosticLease>({
      prefix: diagnosticLeasePrefix,
    });
    const next = await this.ctx.storage.transaction(async (storage) => {
      await storage.delete([...runStorage]);
      await storage.delete(
        [...leases]
          .filter(([, lease]) => lease.expiresAt <= now)
          .map(([key]) => key),
      );
      const [first, ...rest] = (await storage.get<string[]>(queuedRuns)) ?? [];
      if (rest.length) await storage.put(queuedRuns, rest);
      else await storage.delete(queuedRuns);
      if (first) await storage.put("runId", first);
      return first;
    });
    if (next) await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Collects the Turn's work from the Runner and keeps it in R2 for the next
   * Turn, retrying a few times within the save window. When it cannot be
   * kept, the Session records that its work was lost; when the Turn never
   * worked on it, the previous saved work stays current.
   */
  private async saveContinuity(container: Container, run: ContinuityRun) {
    const bucket = this.env.RUN_ARTIFACTS;
    const sessionId = await this.ctx.storage.get<string>("sessionId");
    const runnerKey = await this.ctx.storage.get<string>(runnerKeyStorage);
    const key = sessionId && continuityKey(sessionId, run.runId);
    const until = Date.now() + continuitySaveMs;
    const outcome = await observeRun(
      this.env.DB,
      run.runId,
      "continuity",
      async () => {
        if (!bucket || !key) return "lost" as const;
        let failures = 0;
        while (failures < 3 && Date.now() < until) {
          try {
            const response = await container
              .getTcpPort(8080)
              .fetch(`http://runner/job/${run.runId}/continuity`, {
                headers: runnerHeaders(runnerKey),
                signal: AbortSignal.timeout(
                  Math.max(0, Math.min(60_000, until - Date.now())),
                ),
              });
            if (response.status === 202) {
              await response.body?.cancel();
              await pause();
              continue;
            }
            if (response.status === 204 || response.status === 404) {
              await response.body?.cancel();
              return "skipped" as const;
            }
            const size = Number(response.headers.get("Content-Length"));
            if (
              response.status !== 200 ||
              !response.body ||
              !(size > 0 && size <= maxContinuityBytes)
            ) {
              await response.body?.cancel();
              return "lost" as const;
            }
            // R2 takes a stream of known length, as this response is.
            await (
              bucket.put as (key: string, value: unknown) => Promise<unknown>
            ).call(bucket, key, response.body);
            return "saved" as const;
          } catch {
            failures += 1;
            await pause();
          }
        }
        return "lost" as const;
      },
      (result) => (result === "lost" ? "failed" : "succeeded"),
    );
    if (outcome === "skipped") return;
    const previous =
      await this.ctx.storage.get<ContinuityRecord>(continuityStorage);
    await this.ctx.storage.put(
      continuityStorage,
      outcome === "saved" && key
        ? ({ key, baseSha: run.baseSha } satisfies ContinuityRecord)
        : ({ lost: true } satisfies ContinuityRecord),
    );
    if (previous && "key" in previous && previous.key !== key)
      await bucket?.delete?.(previous.key).catch(() => {});
  }

  private async startRunner(
    deadlineAt: number,
    instance: "lite" | "standard-3",
    egress?: {
      runId: string;
      sessionId: string;
      github: boolean;
      codex: boolean;
    },
  ) {
    const container = this.ctx.container;
    const image = container?.images.runner;
    if (!container || !image) throw new Error("Runner binding unavailable");

    // Intercepts last until the container stops. HTTPS ones must exist before
    // it starts, so that its CA certificate is in place for the entrypoint.
    if (egress) {
      const exports = this.ctx.exports as unknown as RunnerExports;
      const props = {
        props: { runId: egress.runId, sessionId: egress.sessionId },
      };
      if (egress.github)
        for (const host of githubEgressHosts)
          await container.interceptOutboundHttps(
            host,
            exports.GitHubEgress(props),
          );
      if (egress.codex)
        for (const host of codexEgressHosts)
          await container.interceptOutboundHttps(
            host,
            exports.ModelEgress(props),
          );
    }
    // Agent commands may always reach the internet: credentials stay outside.
    container.start({ image, instance, enableInternet: true });
    // The Turn's work is saved after the Agent's time is over.
    await container.setInactivityTimeout(
      Math.max(30_000, deadlineAt - Date.now() + 30_000 + continuitySaveMs),
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
    const lease = await this.ctx.storage.get<DiagnosticLease>(
      diagnosticLeaseKey(runId),
    );
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
    await this.ctx.storage.put(diagnosticLeaseKey(runId), {
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

  /** The Run's GitHub token, for the egress Worker that adds it to requests. */
  async githubToken(runId: string): Promise<string | null> {
    if ((await this.ctx.storage.get<string>("runId")) !== runId) return null;
    if (await this.ctx.storage.get<boolean>(agentEgressClosed)) return null;
    const grant =
      await this.ctx.storage.get<RepositoryGrant>("repositoryGrant");
    const key = this.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!grant || grant.expiresAt <= Date.now() || !key) return null;
    return v.parse(
      v.string(),
      await unseal(grant.value, key, `tailos:github:${runId}`),
    );
  }

  private async closeGitHubEgress() {
    await this.ctx.storage.put(agentEgressClosed, true);
  }

  /** The Run's Codex access, for the egress Worker that adds it to requests. */
  async modelAccess(runId: string): Promise<ModelAccess | null> {
    if (await this.ctx.storage.get<boolean>(agentEgressClosed)) return null;
    const lease = await this.ctx.storage.get<RefreshLease>("refreshLease");
    if (!lease || lease.runId !== runId || lease.expiresAt <= Date.now())
      return null;
    const rejected = await this.ctx.storage.get<string>(rejectedModelAccess);
    const access = await this.env.CREDENTIALS?.getByName(
      lease.connectionId,
    ).issueAccess(
      rejected
        ? {
            accessVersion: rejected,
            connectionVersion: lease.connectionVersion,
          }
        : undefined,
    );
    if (rejected) await this.ctx.storage.delete(rejectedModelAccess);
    if (!access || access.connectionVersion !== lease.connectionVersion)
      return null;
    return {
      accessToken: access.accessToken,
      accountId: access.accountId,
      accessVersion: access.accessVersion,
    };
  }

  /**
   * Records that the model API refused an access token of this Run, so the
   * next request refreshes it. Any process in the container can cause a 401,
   * so a forced refresh happens at most once per `forcedRefreshInterval`.
   */
  async rejectModelAccess(runId: string, accessVersion: string) {
    await this.ctx.storage.transaction(async (storage) => {
      const lease = await storage.get<RefreshLease>("refreshLease");
      const now = Date.now();
      if (
        lease?.runId !== runId ||
        now - lease.lastRefreshAt < forcedRefreshInterval
      )
        return;
      await storage.put("refreshLease", { ...lease, lastRefreshAt: now });
      await storage.put(rejectedModelAccess, accessVersion);
    });
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
    // The Agent is done once its work is checked: nothing may add to it.
    await this.closeGitHubEgress();
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
      // The container never receives the token: the model egress Worker adds
      // it to Codex's requests.
      access: {
        ...access,
        accessToken: placeholderAccessToken(
          access.accountId,
          access.planType,
          deadlineAt,
        ),
      },
      // Base URL of the publication checkpoint.
      refresh: { url: origin + `/_runner/runs/${runId}/`, bearer },
    };
  }

  private get github() {
    const appId = this.env.TAILOS_GH_APP_ID;
    const privateKey = this.env.TAILOS_GH_APP_PRIVATE_KEY;
    return appId && privateKey ? new GitHubApp({ appId, privateKey }) : null;
  }

  /** Revokes the Run's GitHub token; false while a retry is scheduled. */
  private async revokeRepositoryGrant(runId: string) {
    const grant =
      await this.ctx.storage.get<RepositoryGrant>("repositoryGrant");
    if (!grant) return true;
    if (grant.expiresAt <= Date.now()) {
      await this.ctx.storage.delete("repositoryGrant");
      return true;
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
        return false;
      }
      // oxlint-disable-next-line no-console -- Record revocation exhaustion without token data.
      console.warn("Repository grant revocation failed; relying on expiry");
    }
    await this.ctx.storage.delete("repositoryGrant");
    return true;
  }

  /**
   * What the Session's previous Turn left for this one: its saved work and
   * base, a record that it was lost, or nothing for a first Turn. Null when
   * the saved work cannot be read now, so that this Turn does not replace it.
   */
  private async previousWork(): Promise<{
    restore?: "saved" | "lost";
    baseSha?: string;
    archive?: { body?: unknown };
  } | null> {
    const record =
      await this.ctx.storage.get<ContinuityRecord>(continuityStorage);
    if (!record) return {};
    if (!("key" in record)) return { restore: "lost" };
    const bucket = this.env.RUN_ARTIFACTS;
    if (!bucket) return null;
    const archive = await bucket.get(record.key).catch(() => undefined);
    if (archive === undefined) return null;
    return archive?.body
      ? { restore: "saved", baseSha: record.baseSha, archive }
      : { restore: "lost" };
  }

  private async submitJob(request: RunRequest) {
    const job = await this.prepareJob(request).catch(() => null);
    if (!job)
      return { status: "failed", errorCode: "provider_unavailable" } as const;

    const target =
      request.context.engine === "codex"
        ? request.context.repository
        : undefined;
    const trigger =
      request.context.engine === "codex" ? request.context.trigger : undefined;
    // Planning keeps its own conversation until it becomes a Routine.
    const previous =
      target && trigger && job.engine === "codex" && job.mode !== "plan"
        ? await this.previousWork()
        : undefined;
    if (previous === null)
      return { status: "failed", errorCode: "runner_unavailable" } as const;
    if (previous && job.engine === "codex")
      job.continuity = previous.restore ? { restore: previous.restore } : {};
    if (target && trigger && job.engine === "codex") {
      const issue = triggerIssue(trigger);
      if (issue)
        job.githubContext = {
          kind: "issue",
          number: issue.issueNumber,
          ...(issue.issueContentHash && {
            contentHash: issue.issueContentHash,
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
        .checkout(target, trigger, request.runId, request.context.mode)
        .catch(() => null);
      if (!checkout)
        return {
          status: "failed",
          errorCode: "repository_unavailable",
        } as const;
      try {
        if (
          request.context.mode === "plan" &&
          checkout.issueSnapshot &&
          job.githubContext
        ) {
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
      // The saved work sits on the base it started from, not on the latest
      // default branch.
      if (previous?.baseSha) checkout.baseSha = previous.baseSha;
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
      // The token stays here: the egress Worker adds it to GitHub requests.
      job.checkout = {
        repository: target.repository,
        baseSha: checkout.baseSha,
        branch: checkout.branch,
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
    const sessionId = await this.ctx.storage.get<string>("sessionId");
    if (!sessionId)
      return { status: "failed", errorCode: "runner_unavailable" } as const;
    const port = await observeRun(this.env.DB, request.runId, "container", () =>
      this.startRunner(
        job.deadlineAt,
        job.engine === "fake" ? "lite" : "standard-3",
        job.engine === "fake"
          ? undefined
          : {
              runId: request.runId,
              sessionId,
              github: !!job.checkout,
              codex: job.engine === "codex",
            },
      ),
    );
    let key = await this.ctx.storage.get<string>(runnerKeyStorage);
    if (!key) {
      key = newRunLease();
      await this.ctx.storage.put(runnerKeyStorage, key);
    }
    if (job.engine === "codex" && job.continuity && job.checkout) {
      // Set before the job: a job whose acknowledgement is lost still saves.
      await this.ctx.storage.put(continuityRunStorage, {
        runId: request.runId,
        baseSha: job.checkout.baseSha,
      } satisfies ContinuityRun);
      if (previous?.archive?.body) {
        const upload = await port.fetch("http://runner/continuity", {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            ...runnerHeaders(key),
          },
          body: previous.archive.body as ReadableStream,
          signal: AbortSignal.timeout(
            Math.max(0, Math.min(60_000, job.deadlineAt - Date.now())),
          ),
        });
        await upload.body?.cancel();
        // Never start over silently: the saved work stays for a later Turn.
        if (upload.status !== 204)
          return { status: "failed", errorCode: "runner_unavailable" } as const;
      }
    }
    const response = await port.fetch("http://runner/job", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...runnerHeaders(key) },
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
    const repository =
      context.engine === "codex" ? context.repository : undefined;
    const trigger = context.engine === "codex" ? context.trigger : undefined;
    const target = repository && trigger ? { repository, trigger } : undefined;
    if (context.mode === "plan") {
      const status = await this.readRunnerStatus(runId);
      if (status.status !== "running") await this.closeGitHubEgress();
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
    if (pending) await this.closeGitHubEgress();
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
            target.repository,
            target.trigger,
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
    if (status.status !== "running") await this.closeGitHubEgress();
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
        if (
          !(await github.hasCommit(
            target.repository,
            target.trigger,
            runId,
            pending,
          ))
        ) {
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
    const key = await this.ctx.storage.get<string>(runnerKeyStorage);
    const reply = await container
      .getTcpPort(8080)
      .fetch(`http://runner/job/${runId}`, {
        headers: runnerHeaders(key),
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
    target: { repository: RepositoryTarget; trigger: RunTrigger },
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
      () =>
        github.publish(
          target.repository,
          target.trigger,
          runId,
          publication,
          deadlineAt,
        ),
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

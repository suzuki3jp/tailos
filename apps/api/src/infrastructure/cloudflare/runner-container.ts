import { dispatchSessionInbox } from "@/infrastructure/d1/session-inbox.ts";
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
  ExecutionContext,
  githubJobContext,
  maxContinuityBytes,
  maxRunnerJobBytes,
  RunnerStatus,
  type RunnerJob,
} from "@tailos/core/runner";
import * as v from "valibot";
import type { Bindings, ModelAccess, RunnerControl } from "@/bindings.ts";
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
import { currentInstructions } from "@/application/routines/routines.ts";
import { deliverTimelineNotifications } from "./session-stream.ts";
import { runStarter } from "./run-start.ts";
import { githubEgressHosts, type GitHubEgressProps } from "./github-egress.ts";
import { modelEgressHosts, type ModelEgressProps } from "./model-egress.ts";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

type RepositoryGrant = {
  value: Sealed;
  expiresAt: number;
  attempts: number;
};

/** Names the model connection the Run's Agent may use while it works. */
type RefreshLease = {
  runId: string;
  /** The Model Provider of the connection; leases without it are Codex's. */
  engine?: "codex" | "claude";
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
 * Set once the Turn is over, before its work is saved and the container goes:
 * the egress Workers stop adding the Run's credentials, so that a process the
 * Agent left behind cannot use GitHub or the model connection afterwards.
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

/**
 * Stands in for the Claude OAuth token inside the container. It has the
 * token's shape and nothing of the user's: the model egress Worker replaces it.
 */
export const placeholderClaudeToken = "sk-ant-oat01-tailos-placeholder";

/** Authorizes the Run's controller on the Runner's HTTP server. */
const runnerKeyStorage = "runnerKey";
/**
 * Where the Session's work stands for its next Turn: saved in R2 on top of
 * its base commit, or lost because the last Turn's work could not be saved.
 * It belongs to the Session, so it outlives each Run.
 */
type ContinuityRecord =
  | { key: string; baseSha: string; snapshot?: ContainerSnapshotRecord }
  | { lost: true };
/**
 * A snapshot of the container that holds the saved work in place, and the
 * image it was taken from: it only restarts that image.
 */
type ContainerSnapshotRecord = { id: string; image: string };
/**
 * How long a container waits for the Session's next Turn before it is
 * destroyed. At 0 it never waits: the next Turn restores its snapshot.
 */
export const sessionIdleMs = 0;
const idleUntilStorage = "idleUntil";
const continuityStorage = "continuity";
/** The Run whose work is saved when it ends, and the base it works on. */
type ContinuityRun = { runId: string; baseSha: string };
const continuityRunStorage = "continuityRun";
const continuityKey = (sessionId: string, runId: string) =>
  `sessions/v1/${sessionId}/continuity/${runId}`;

/**
 * The branches the current Run pushed, and the repository of each, which the
 * egress Worker records: the Run's result shows the pull requests of those in
 * its target repository.
 */
type PushedBranch = { repository: string; branch: string };
const pushedBranchesStorage = "pushedBranches";
/** The most branches one Run records. */
export const maxPushedBranches = 20;

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
  agentEgressClosed,
  continuityRunStorage,
  pushedBranchesStorage,
] as const;
const runnerHeaders = (key: string | undefined) =>
  key ? { Authorization: `Bearer ${key}` } : undefined;

/**
 * Processes the Turns of one Session, one at a time, in a container of its
 * own. The Durable Object is named after the Session; a Turn is a Run.
 */
export class RunnerContainer
  extends DurableObject<Bindings>
  implements RunnerControl
{
  private pollUnavailable = false;
  protected idleMs = sessionIdleMs;
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
    if (!runId) {
      await this.endIdle();
      return;
    }

    const driver: RunnerDriver = {
      start: (job) =>
        observeRun(
          this.env.DB,
          runId,
          "runner",
          () => this.submitJob(job),
          (result) => (result.status === "failed" ? "failed" : "succeeded"),
        ),
      poll: async (id, context) => {
        try {
          const result = await this.pollJob(id, context);
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

    // The Run is over: nothing may use its credentials while the rest of the
    // cleanup, including revocation retries, is still pending.
    await this.closeGitHubEgress();
    await this.ctx.storage.delete(["refreshLease", rejectedModelAccess]);
    try {
      const container = this.ctx.container;
      // Keep the Turn's work for the Session before the container goes.
      const continuing =
        await this.ctx.storage.get<ContinuityRun>(continuityRunStorage);
      if (continuing?.runId === runId)
        try {
          await this.saveContinuity(container, continuing);
        } catch {
          // oxlint-disable-next-line no-console -- Record save failures without work data.
          console.warn("Saving the Session's work failed", { runId });
          await this.ctx.storage.put(continuityStorage, {
            lost: true,
          } satisfies ContinuityRecord);
        } finally {
          // Saved once: a cleanup that is retried, for instance while the
          // GitHub token is revoked, must not save again after the container
          // is gone and record the saved work as lost.
          await this.ctx.storage.delete(continuityRunStorage);
        }
      // Its work is saved: the container may wait for the Session's next
      // Turn, or go. A retried cleanup keeps the wait the first one chose.
      const idleUntil =
        continuing?.runId === runId
          ? Date.now() + this.idleMs
          : await this.ctx.storage.get<number>(idleUntilStorage);
      if (this.idleMs > 0 && idleUntil && container?.running)
        await this.ctx.storage.put(idleUntilStorage, idleUntil);
      else if (container?.running)
        await observeRun(this.env.DB, runId, "cleanup", () =>
          container.destroy(),
        );
    } finally {
      // A revocation that will be retried keeps the Run current until then.
      if (await this.revokeRepositoryGrant(runId)) await this.finishRun();
      // The Session's next message, or another Session's, may start now.
      const next = await dispatchSessionInbox(this.env.DB);
      const schedule = runStarter(this.env);
      if (schedule) await Promise.all(next.map((id) => schedule(id)));
      const idleUntil = await this.ctx.storage.get<number>(idleUntilStorage);
      if (idleUntil && !(await this.ctx.storage.get<string>("runId")))
        await this.ctx.storage.setAlarm(idleUntil);
    }
  }

  /** Destroys a container that waited for the next Turn long enough. */
  private async endIdle() {
    const idleUntil = await this.ctx.storage.get<number>(idleUntilStorage);
    if (!idleUntil) return;
    if (idleUntil > Date.now()) {
      await this.ctx.storage.setAlarm(idleUntil);
      return;
    }
    await this.ctx.container?.destroy().catch(() => {});
    await this.ctx.storage.delete(idleUntilStorage);
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
  private async saveContinuity(
    container: Container | undefined,
    run: ContinuityRun,
  ) {
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
        // The Runner took the job, so its work may have changed: when it is
        // gone, the Session must not silently go back to older work.
        if (!bucket || !key || !container?.running) return "lost" as const;
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
            // Only the Runner can tell that the Agent never started.
            if (response.status === 204) {
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
    // The saved work is the source of truth; the snapshot only restores it
    // faster, so a failed snapshot leaves the Turn as it is.
    const snapshot =
      outcome === "saved" && container?.running
        ? await this.snapshot(container, run.runId)
        : undefined;
    const previous =
      await this.ctx.storage.get<ContinuityRecord>(continuityStorage);
    await this.ctx.storage.put(
      continuityStorage,
      outcome === "saved" && key
        ? ({
            key,
            baseSha: run.baseSha,
            ...(snapshot && { snapshot }),
          } satisfies ContinuityRecord)
        : ({ lost: true } satisfies ContinuityRecord),
    );
    if (previous && "key" in previous && previous.key !== key)
      await bucket?.delete?.(previous.key).catch(() => {});
  }

  /** Snapshots the container with the Turn's work, for the next Turn. */
  private async snapshot(
    container: Container,
    runId: string,
  ): Promise<ContainerSnapshotRecord | undefined> {
    const image = container.images.runner;
    if (!image) return undefined;
    return observeRun(this.env.DB, runId, "container", async () => {
      const taken = await container.snapshotContainer({ name: runId });
      return { id: taken.id, image };
    }).catch(() => undefined);
  }

  /**
   * Starts the Runner: from the Session's snapshot when it was taken from
   * the current image, otherwise from the image itself. A container kept
   * waiting for this Session is used as it is.
   */
  private async startRunner(
    deadlineAt: number,
    instance: "lite" | "standard-3",
    egress?: { sessionId: string; github: boolean },
    snapshot?: ContainerSnapshotRecord,
  ) {
    const container = this.ctx.container;
    const image = container?.images.runner;
    if (!container || !image) throw new Error("Runner binding unavailable");
    // A wait from an earlier Turn ends here, whether or not its container is
    // kept, so a later retried cleanup cannot mistake it for this Turn's.
    const waited =
      this.idleMs > 0
        ? await this.ctx.storage.get<number>(idleUntilStorage)
        : undefined;
    if (waited) await this.ctx.storage.delete(idleUntilStorage);
    if (waited && container.running) {
      // A Runner image deployed while it waited must not keep running. When
      // the image cannot be told, the container is started again.
      const kept = await container.inspect().catch(() => null);
      if (kept?.image === image) {
        await container.setInactivityTimeout(this.inactivity(deadlineAt));
        return this.ready(container, deadlineAt);
      }
      await container.destroy().catch(() => {});
    }

    // Agent commands may always reach the internet: credentials stay outside.
    // A snapshot of an older image would silently run the older Runner.
    if (snapshot?.image === image) {
      await this.intercept(container, egress);
      container.start({
        containerSnapshot: { id: snapshot.id },
        instance,
        enableInternet: true,
      });
      await container.setInactivityTimeout(this.inactivity(deadlineAt));
      const restored = await this.ready(container, deadlineAt).catch(
        () => undefined,
      );
      const running = await container.inspect().catch(() => null);
      if (restored && (!running?.image || running.image === image))
        return restored;
      await container.destroy().catch(() => {});
    }
    // The intercepts of a destroyed container are gone with it.
    await this.intercept(container, egress);
    container.start({ image, instance, enableInternet: true });
    await container.setInactivityTimeout(this.inactivity(deadlineAt));
    return this.ready(container, deadlineAt);
  }

  /**
   * Sends the container's GitHub and model API traffic to the egress Workers.
   * Intercepts last until the container stops. HTTPS ones must exist before
   * it starts, so that its CA certificate is in place for the entrypoint.
   */
  private async intercept(
    container: Container,
    egress?: { sessionId: string; github: boolean },
  ) {
    if (!egress) return;
    const exports = this.ctx.exports as unknown as RunnerExports;
    // A kept container serves the Session's later Runs too, so the egress
    // Workers ask for the Run that is current then.
    const props = { props: { sessionId: egress.sessionId } };
    if (egress.github)
      for (const host of githubEgressHosts)
        await container.interceptOutboundHttps(
          host,
          exports.GitHubEgress(props),
        );
    // Both providers' hosts: the egress Worker adds credentials only for the
    // provider of the Run that is current then.
    for (const host of modelEgressHosts)
      await container.interceptOutboundHttps(host, exports.ModelEgress(props));
  }

  /**
   * How long the container may go without requests: the Turn, saving its
   * work, and waiting for the next Turn.
   */
  private inactivity(deadlineAt: number) {
    return Math.max(
      30_000,
      deadlineAt - Date.now() + 30_000 + continuitySaveMs + this.idleMs,
    );
  }

  private async ready(container: Container, deadlineAt: number) {
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
  async githubToken(runId?: string): Promise<string | null> {
    const current = await this.ctx.storage.get<string>("runId");
    if (!current || (runId !== undefined && current !== runId)) return null;
    runId = current;
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

  /** The lease of the current Run on a Model Provider, while its Agent works. */
  private async agentLease(
    engine: "codex" | "claude",
    runId?: string,
  ): Promise<RefreshLease | null> {
    if (await this.ctx.storage.get<boolean>(agentEgressClosed)) return null;
    const lease = await this.ctx.storage.get<RefreshLease>("refreshLease");
    if (
      !lease ||
      (lease.engine ?? "codex") !== engine ||
      (runId !== undefined && lease.runId !== runId) ||
      lease.expiresAt <= Date.now()
    )
      return null;
    return lease;
  }

  /** The Run's Claude token, for the egress Worker that adds it to requests. */
  async claudeAccess(runId?: string): Promise<string | null> {
    const lease = await this.agentLease("claude", runId);
    if (!lease) return null;
    const access = await this.env.CREDENTIALS?.getByName(
      lease.connectionId,
    ).issueClaudeAccess();
    if (!access || access.connectionVersion !== lease.connectionVersion)
      return null;
    return access.token;
  }

  /** The Run's Codex access, for the egress Worker that adds it to requests. */
  async modelAccess(runId?: string): Promise<ModelAccess | null> {
    const lease = await this.agentLease("codex", runId);
    if (!lease) return null;
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
  async rejectModelAccess(runId: string | undefined, accessVersion: string) {
    await this.ctx.storage.transaction(async (storage) => {
      const lease = await storage.get<RefreshLease>("refreshLease");
      const now = Date.now();
      if (
        !lease ||
        (runId !== undefined && lease.runId !== runId) ||
        now - lease.lastRefreshAt < forcedRefreshInterval
      )
        return;
      await storage.put("refreshLease", { ...lease, lastRefreshAt: now });
      await storage.put(rejectedModelAccess, accessVersion);
    });
  }

  /**
   * Records the branches the current Run pushed, as the egress Worker reads
   * them from the push. Nothing is recorded once the Run's work is over.
   */
  async recordPush(
    runId: string | undefined,
    repository: string,
    branches: string[],
  ) {
    await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<string>("runId");
      if (!current || (runId !== undefined && current !== runId)) return;
      if (await storage.get<boolean>(agentEgressClosed)) return;
      const pushed =
        (await storage.get<PushedBranch[]>(pushedBranchesStorage)) ?? [];
      const next = [...pushed];
      for (const branch of branches)
        if (
          next.length < maxPushedBranches &&
          !next.some(
            (known) =>
              known.repository === repository && known.branch === branch,
          )
        )
          next.push({ repository, branch });
      if (next.length !== pushed.length)
        await storage.put(pushedBranchesStorage, next);
    });
  }

  private async prepareJob(request: RunRequest): Promise<RunnerJob | null> {
    const { runId, prompt, deadlineAt, context } = request;
    const diagnostics = await this.diagnosticContext(runId, deadlineAt).catch(
      () => undefined,
    );
    // A Routine's message is what someone wrote; its prompt says what to do.
    const instructions = currentInstructions(
      context.engine === "fake" ? undefined : context.instructions,
    );
    const base = {
      version: 1 as const,
      ...(context.mode === "plan" && { mode: "plan" as const }),
      runId,
      prompt: instructions ?? prompt,
      ...(instructions && { message: prompt }),
      deadlineAt,
      ...(diagnostics && { diagnostics }),
    };
    if (context.engine === "fake") return { ...base, engine: "fake" };

    const origin = this.env.TAILOS_PUBLIC_ORIGIN;
    if (!origin || !this.env.CREDENTIALS) return null;
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) return null;
    const connection = this.env.CREDENTIALS.getByName(context.connectionId);
    // The egress Workers add the connection's credentials while this lease
    // lasts.
    const lease = async (connectionVersion: string) => {
      await this.ctx.storage.put("refreshLease", {
        runId,
        engine: context.engine,
        connectionId: context.connectionId,
        connectionVersion,
        expiresAt: deadlineAt,
        lastRefreshAt: 0,
      } satisfies RefreshLease);
    };
    const selection = {
      ...(context.model && { model: context.model }),
      ...(context.effort && { effort: context.effort }),
    };

    if (context.engine === "claude") {
      const access = await connection.issueClaudeAccess();
      if (!access) return null;
      await lease(access.connectionVersion);
      return {
        ...base,
        engine: "claude",
        ...selection,
        // The container never receives the token: the model egress Worker
        // adds it to Claude Code's requests.
        access: {
          token: placeholderClaudeToken,
          connectionVersion: access.connectionVersion,
        },
      };
    }

    const access = await connection.issueAccess();
    if (!access) return null;
    await lease(access.connectionVersion);
    return {
      ...base,
      engine: "codex",
      ...selection,
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
  private async previousWork(runId: string): Promise<{
    restore?: "saved" | "lost";
    baseSha?: string;
    archive?: { body?: unknown };
    snapshot?: ContainerSnapshotRecord;
  } | null> {
    const record =
      await this.ctx.storage.get<ContinuityRecord>(continuityStorage);
    // Earlier Turns left nothing, as before Sessions kept their work: the
    // Agent hears that the conversation is gone.
    if (!record)
      return (await this.hadEarlierTurns(runId)) ? { restore: "lost" } : {};
    if (!("key" in record)) return { restore: "lost" };
    const bucket = this.env.RUN_ARTIFACTS;
    if (!bucket) return null;
    const archive = await bucket.get(record.key).catch(() => undefined);
    if (archive === undefined) return null;
    return archive?.body
      ? {
          restore: "saved",
          baseSha: record.baseSha,
          archive,
          ...(record.snapshot && { snapshot: record.snapshot }),
        }
      : { restore: "lost" };
  }

  private async hadEarlierTurns(runId: string) {
    const row = await this.env.DB.prepare(
      `SELECT 1 AS earlier FROM runs r JOIN runs current ON current.session_id = r.session_id
      WHERE current.id = ? AND r.id != current.id AND r.created_at < current.created_at LIMIT 1`,
    )
      .bind(runId)
      .first<{ earlier: number }>();
    return !!row;
  }

  private async submitJob(request: RunRequest) {
    const job = await this.prepareJob(request).catch(() => null);
    if (!job)
      return { status: "failed", errorCode: "provider_unavailable" } as const;

    const target =
      request.context.engine === "fake"
        ? undefined
        : request.context.repository;
    const trigger =
      request.context.engine === "fake" ? undefined : request.context.trigger;
    const previous =
      target && trigger && job.engine !== "fake"
        ? await this.previousWork(request.runId)
        : undefined;
    if (previous === null)
      return { status: "failed", errorCode: "runner_unavailable" } as const;
    if (previous && job.engine !== "fake")
      job.continuity = previous.restore ? { restore: previous.restore } : {};
    if (target && trigger && job.engine !== "fake") {
      const githubContext = githubJobContext(request.context);
      if (githubContext) job.githubContext = githubContext;
      const github = this.github;
      const key = this.env.CREDENTIAL_ENCRYPTION_KEY;
      if (!github || !key)
        return {
          status: "failed",
          errorCode: "repository_unavailable",
        } as const;
      const checkout = await github
        .checkout(target, trigger, request.context.mode)
        .catch(() => null);
      if (!checkout)
        return {
          status: "failed",
          errorCode: "repository_unavailable",
        } as const;
      // The Session's work stays on the base it started from; the Agent moves
      // it to newer commits itself.
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
        defaultBranch: target.defaultBranch,
        author: checkout.author,
      };
    }
    // A long message, such as an issue comment, may not fit in a job.
    if (
      new TextEncoder().encode(JSON.stringify(job)).byteLength >
      maxRunnerJobBytes
    )
      return {
        status: "failed",
        errorCode: "message_too_large",
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
          : { sessionId, github: !!job.checkout },
        previous?.snapshot,
      ),
    );
    let key = await this.ctx.storage.get<string>(runnerKeyStorage);
    if (!key) {
      key = newRunLease();
      await this.ctx.storage.put(runnerKeyStorage, key);
    }
    const continuing = job.engine !== "fake" && job.continuity && job.checkout;
    if (continuing) {
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
      // Set before the job: a job whose acknowledgement is lost still saves.
      await this.ctx.storage.put(continuityRunStorage, {
        runId: request.runId,
        baseSha: job.checkout!.baseSha,
      } satisfies ContinuityRun);
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
      // The Runner refused the job: the previous work stays as it was.
      if (continuing) await this.ctx.storage.delete(continuityRunStorage);
      return { status: "failed", errorCode: "runner_unavailable" } as const;
    }
    return { status: "running" } as const;
  }

  private async pollJob(runId: string, context: ExecutionContext) {
    const repository =
      context.engine === "fake" ? undefined : context.repository;
    const trigger = context.engine === "fake" ? undefined : context.trigger;
    const status = await this.readRunnerStatus(runId);
    if (status.status !== "running") await this.closeGitHubEgress();
    if (status.status !== "succeeded") return status;
    if (context.mode === "plan")
      return status.plan
        ? status
        : ({
            status: "failed",
            errorCode: "agent_failed",
            events: status.events,
          } as const);
    if (!repository || !trigger) return status;
    // The Agent pushes and opens pull requests itself: the Run's result shows
    // those of the branches it pushed. They are only shown, so a lookup that
    // fails leaves them out.
    // GitHub names repositories without regard to case.
    const target = repository.repository.toLowerCase();
    const branches = (
      (await this.ctx.storage.get<PushedBranch[]>(pushedBranchesStorage)) ?? []
    )
      .filter((pushed) => pushed.repository.toLowerCase() === target)
      .map((pushed) => pushed.branch);
    const pullRequests = branches.length
      ? await (
          this.github?.branchPullRequests(repository, branches) ??
          Promise.resolve([])
        ).catch(() => [])
      : [];
    return pullRequests.length
      ? {
          ...status,
          publicationResult: { kind: "pull_requests" as const, pullRequests },
        }
      : status;
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
}

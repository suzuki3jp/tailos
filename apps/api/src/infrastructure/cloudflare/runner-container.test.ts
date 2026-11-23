import { expect, test, vi } from "vitest";

import {
  createTestBindings,
  createTestDb,
} from "@/infrastructure/d1/testing.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { hashRunLease, newRunLease } from "@/infrastructure/auth/run-lease.ts";
import { GitHubApp } from "@/infrastructure/github/app.ts";
import { RunnerContainer } from "@/infrastructure/cloudflare/runner-container.ts";
import { runSession } from "@/infrastructure/cloudflare/run-start.ts";
import type { DiagnosticBatch } from "@tailos/core/diagnostics";
import { registerDiagnosticProducer } from "@/infrastructure/diagnostics/store.ts";
import { seal } from "@/infrastructure/auth/sealed-store.ts";

/** Durable Object storage kept in a map, for the calls the Runner makes. */
function memoryStorage(
  values: Map<string, unknown>,
  setAlarm: (at: number) => Promise<void> = async () => {},
) {
  const records = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) values.delete(key);
      return true;
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)));
    },
  };
  return {
    ...records,
    async transaction<T>(body: (storage: typeof records) => Promise<T>) {
      return body(records);
    },
    setAlarm,
  };
}

test("a diagnostics lease accepts late telemetry but cannot publish or obtain model access", async (t) => {
  const { DB, RUN_ARTIFACTS } = await createTestBindings(t);
  const { runId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "diagnostics",
    ownerId: "owner",
    concurrencyKey: "target",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  });
  const producerId = crypto.randomUUID();
  await registerDiagnosticProducer(DB, runId, producerId);
  await DB.prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .bind(runId)
    .run();
  await DB.prepare(
    "UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?",
  )
    .bind(Date.now(), runId)
    .run();
  const bearer = newRunLease();
  const lease = {
    runId,
    producerId,
    expiresAt: Date.now() + 60_000,
    digest: await hashRunLease(bearer),
  };
  const runner = new RunnerContainer(
    {
      storage: {
        async get(key: string) {
          return key === `diagnosticLease/${runId}` ? lease : undefined;
        },
      },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    { DB, RUN_ARTIFACTS },
  );
  const batch: DiagnosticBatch = {
    version: 1,
    batchId: crypto.randomUUID(),
    producerId,
    records: [],
    completed: { lastSeq: 0, dropped: 0 },
  };
  expect(await runner.ingestDiagnostics(runId, newRunLease(), batch)).toBe(
    false,
  );
  expect(
    await runner.ingestDiagnostics(crypto.randomUUID(), bearer, batch),
  ).toBe(false);
  expect(await runner.ingestDiagnostics(runId, bearer, batch)).toBe(true);
  expect(await runner.modelAccess(runId)).toBeNull();
  expect(
    await runner.stagePublication(runId, bearer, {
      kind: "prepared",
      branch: `tailos/issue-1/${runId}`,
      sha: "a".repeat(40),
      reply: "test",
      events: [],
    }),
  ).toBe(false);
  lease.expiresAt = Date.now() - 1;
  expect(await runner.ingestDiagnostics(runId, bearer, batch)).toBe(false);
});

test("runs the Turns of a Session one at a time and clears each Run's state", async (t) => {
  const { DB } = await createTestBindings(t);
  const first = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "first",
    ownerId: "owner",
    concurrencyKey: "target",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  });
  const second = crypto.randomUUID();
  const values = new Map<string, unknown>();
  const setAlarm = vi.fn(async (_at: number) => {});
  const runner = new RunnerContainer(
    {
      storage: memoryStorage(values, setAlarm),
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    { DB },
  );
  await runner.schedule(first.runId, first.sessionId);
  await runner.schedule(second, first.sessionId);
  await runner.schedule(second, first.sessionId);
  // The second Turn waits: the container and storage belong to one Run.
  expect(values.get("runId")).toBe(first.runId);
  expect(values.get("queuedRuns")).toStrictEqual([second]);

  await DB.prepare(
    "UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?",
  )
    .bind(Date.now(), first.runId)
    .run();
  for (const key of ["refreshLease", "agentEgressClosed", "runnerKey"])
    values.set(key, true);
  values.set(`diagnosticLease/${first.runId}`, {
    expiresAt: Date.now() + 60_000,
  });
  values.set("diagnosticLease/expired", { expiresAt: Date.now() - 1 });
  setAlarm.mockClear();
  await runner.alarm();

  expect(values.get("runId")).toBe(second);
  expect(values.has("queuedRuns")).toBe(false);
  expect(setAlarm).toHaveBeenCalledOnce();
  for (const key of ["refreshLease", "agentEgressClosed"])
    expect(values.has(key), key).toBe(false);
  // The controller's key stays with the Session's container.
  expect(values.get("runnerKey")).toBe(true);
  // Late telemetry of the finished Run is still accepted until it expires.
  expect(values.has(`diagnosticLease/${first.runId}`)).toBe(true);
  expect(values.has("diagnosticLease/expired")).toBe(false);
});

test("stops a finished Run's credentials while its token revocation is retried", async (t) => {
  const { DB } = await createTestBindings(t);
  const { runId, sessionId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "revocation",
    ownerId: "owner",
    concurrencyKey: "target",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  });
  await DB.prepare(
    "UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?",
  )
    .bind(Date.now(), runId)
    .run();
  const values = new Map<string, unknown>([
    ["runId", runId],
    ["sessionId", sessionId],
    [
      "refreshLease",
      {
        runId,
        digest: "digest",
        connectionId: "connection",
        connectionVersion: "connection-1",
        expiresAt: Date.now() + 60_000,
        lastRefreshAt: 0,
      },
    ],
    ["rejectedModelAccess", "version-1"],
    ["publicationDigest", "digest"],
    [
      "repositoryGrant",
      { value: {}, expiresAt: Date.now() + 60_000, attempts: 0 },
    ],
  ]);
  const setAlarm = vi.fn(async (_at: number) => {});
  // Without the GitHub App the revocation fails and is retried.
  const runner = new RunnerContainer(
    {
      storage: memoryStorage(values, setAlarm),
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    { DB },
  );
  await runner.alarm();
  expect(setAlarm).toHaveBeenCalledOnce();
  expect(values.get("runId")).toBe(runId);
  expect(values.get("agentEgressClosed")).toBe(true);
  expect(values.has("refreshLease")).toBe(false);
  expect(values.has("rejectedModelAccess")).toBe(false);
  expect(await runner.modelAccess(runId)).toBeNull();
  expect(await runner.githubToken(runId)).toBeNull();

  // Once the grant is gone, nothing of the Run is left for the next one.
  values.set("repositoryGrant", {
    value: {},
    expiresAt: Date.now() - 1,
    attempts: 1,
  });
  await runner.alarm();
  for (const key of ["runId", "publicationDigest", "agentEgressClosed"])
    expect(values.has(key), key).toBe(false);
});

test("a rejected model token forces a refresh at most once every five seconds", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  try {
    const runId = crypto.randomUUID();
    const values = new Map<string, unknown>([
      [
        "refreshLease",
        {
          digest: "digest",
          runId,
          connectionId: "connection",
          connectionVersion: "connection-1",
          expiresAt: Date.now() + 600_000,
          lastRefreshAt: 0,
        },
      ],
    ]);
    const storage = {
      async get(key: string) {
        return values.get(key);
      },
      async put(key: string, value: unknown) {
        values.set(key, value);
      },
      async delete(key: string) {
        return values.delete(key);
      },
      async transaction<T>(body: (storage: unknown) => Promise<T>) {
        return body(storage);
      },
    };
    const issueAccess = vi.fn(async (_rejected?: unknown) => ({
      accessToken: "access",
      accountId: "account",
      accessVersion: "version-2",
      connectionVersion: "connection-1",
    }));
    const runner = new RunnerContainer(
      { storage } as unknown as ConstructorParameters<
        typeof RunnerContainer
      >[0],
      { CREDENTIALS: { getByName: () => ({ issueAccess }) } } as never,
    );

    await runner.rejectModelAccess(runId, "version-1");
    await runner.modelAccess(runId);
    expect(issueAccess).toHaveBeenLastCalledWith({
      accessVersion: "version-1",
      connectionVersion: "connection-1",
    });

    vi.advanceTimersByTime(4_999);
    await runner.rejectModelAccess(runId, "version-2");
    await runner.modelAccess(runId);
    expect(issueAccess).toHaveBeenLastCalledWith(undefined);

    vi.advanceTimersByTime(1);
    await runner.rejectModelAccess(runId, "version-2");
    await runner.rejectModelAccess(crypto.randomUUID(), "version-3");
    await runner.modelAccess(runId);
    expect(issueAccess).toHaveBeenLastCalledWith({
      accessVersion: "version-2",
      connectionVersion: "connection-1",
    });
  } finally {
    vi.useRealTimers();
  }
});

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: DurableObjectState,
      protected env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {},
}));

test("a failed container cleanup preserves the runner health result", async (t) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  t.onTestFinished(() => {
    warn.mockRestore();
  });
  const ctx = {
    container: {
      images: { runner: "runner-image" },
      start() {},
      async setInactivityTimeout() {},
      getTcpPort() {
        return {
          fetch: async () => Response.json({ status: "ok", service: "runner" }),
        };
      },
      async destroy() {
        throw new Error("Cleanup unavailable");
      },
    },
  };
  const runner = new RunnerContainer(
    ctx as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {} as ConstructorParameters<typeof RunnerContainer>[1],
  );

  expect(await runner.checkHealth()).toBe(true);
  expect(warn.mock.calls.length).toBe(1);
});

test("only the active Run lease can stage the expected work branch without overwriting it", async (t) => {
  const DB = await createTestDb(t);
  const { runId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "delivery",
    concurrencyKey: "target",
    ownerId: "owner",
    prompt: "Make changes",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  });
  const branch = `tailos/issue-1/${runId}`;
  await DB.prepare(
    "UPDATE runs SET status = 'running', step_state = ? WHERE id = ?",
  )
    .bind(JSON.stringify({ branch }), runId)
    .run();
  const bearer = newRunLease();
  const digest = await hashRunLease(bearer);
  const runner = new RunnerContainer(
    {
      storage: {
        async get() {
          return { runId, digest, expiresAt: Date.now() + 60_000 };
        },
      },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    { DB },
  );
  const work = {
    kind: "prepared" as const,
    branch,
    sha: "a".repeat(40),
    reply: "Done",
    events: [],
  };
  expect(await runner.stagePublication(runId, newRunLease(), work)).toBe(false);
  expect(
    await runner.stagePublication(runId, bearer, { ...work, branch: "main" }),
  ).toBe(false);
  await DB.prepare("UPDATE runs SET execution_context = ? WHERE id = ?")
    .bind('{"version":1,"engine":"fake","mode":"plan"}', runId)
    .run();
  expect(await runner.stagePublication(runId, bearer, work)).toBe(false);
  await DB.prepare("UPDATE runs SET execution_context = ? WHERE id = ?")
    .bind('{"version":1,"engine":"fake"}', runId)
    .run();
  expect(await runner.stagePublication(runId, bearer, work)).toBe(true);
  expect(await runner.stagePublication(runId, bearer, work)).toBe(true);
  expect(
    await runner.stagePublication(runId, bearer, {
      ...work,
      sha: "b".repeat(40),
    }),
  ).toBe(false);
  expect(
    await DB.prepare(
      "SELECT json_extract(step_state, '$.pendingPublication.sha') AS sha FROM runs WHERE id = ?",
    )
      .bind(runId)
      .first("sha"),
  ).toBe(work.sha);
});

async function preparedRun(
  t: import("vitest").TestContext,
  state: "failed" | "lost" | "unavailable",
) {
  const DB = await createTestDb(t);
  const target = {
    repository: "owner/private",
    repositoryId: 42,
    installationId: 19,
    issueNumber: 8,
    defaultBranch: "main",
    triggerLabel: "tailos:run",
  };
  const { runId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "delivery",
    concurrencyKey: "target",
    ownerId: "owner",
    prompt: "Make changes",
    timeoutMs: 30 * 60_000,
    executionContext: JSON.stringify({
      version: 1,
      engine: "codex",
      connectionId: "codex/c42c7de5-938d-4f93-a6af-d43bb0e7b65c",
      repository: target,
    }),
  });
  const pending = {
    kind: "prepared",
    branch: `tailos/issue-8/${runId}`,
    sha: "a".repeat(40),
    reply: "Done",
    events: [],
  };
  await DB.prepare(
    "UPDATE runs SET status = 'running', step_state = ? WHERE id = ?",
  )
    .bind(
      JSON.stringify({
        version: 1,
        branch: pending.branch,
        pendingPublication: pending,
      }),
      runId,
    )
    .run();
  const setAlarm = vi.fn(async (_at: number) => {});
  const destroy = vi.fn(async () => {});
  const stored = new Map<string, unknown>([["runId", runId]]);
  const ctx = {
    storage: memoryStorage(stored, setAlarm),
    container: {
      running: state !== "lost",
      destroy,
      getTcpPort() {
        return {
          async fetch() {
            if (state === "unavailable")
              throw new Error("Runner status unavailable");
            return Response.json({
              status: "failed",
              errorCode: "agent_failed",
              events: [{ type: "job_failed", at: Date.now() }],
            });
          },
        };
      },
    },
  };
  // This fixture supplies just the Durable Object capabilities used by alarm().
  const runner = new RunnerContainer(
    ctx as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {
      DB,
      TAILOS_GH_APP_ID: "100",
      TAILOS_GH_APP_PRIVATE_KEY: "unused-test-key",
    },
  );
  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });
  return { DB, runId, runner, target, pending, setAlarm, stored };
}

test.for(["failed", "lost"] as const)(
  "ends a prepared publication promptly when the Runner is %s and its commit was not pushed",
  async (state, t) => {
    const { DB, runId, runner, setAlarm, stored } = await preparedRun(t, state);
    let closedAtVerification: unknown;
    const verify = vi
      .spyOn(GitHubApp.prototype, "hasCommit")
      .mockImplementation(async () => {
        closedAtVerification = stored.get("agentEgressClosed");
        return false;
      });
    const publish = vi.spyOn(GitHubApp.prototype, "publish");
    await runner.alarm();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(setAlarm).not.toHaveBeenCalled();
    // A pending publication means the Agent is done with GitHub.
    expect(closedAtVerification).toBe(true);
    // The next Turn of the Session starts without this Run's state.
    expect(stored.has("agentEgressClosed")).toBe(false);
    expect(stored.has("runId")).toBe(false);
    expect(
      await DB.prepare("SELECT status, error_code FROM runs WHERE id = ?")
        .bind(runId)
        .first(),
    ).toStrictEqual({
      status: "failed",
      error_code: state === "lost" ? "runner_lost" : "agent_failed",
    });
  },
);

test("publishes a matching remote commit after the Runner lost the push response", async (t) => {
  const { DB, runId, runner } = await preparedRun(t, "lost");
  const verify = vi
    .spyOn(GitHubApp.prototype, "hasCommit")
    .mockResolvedValue(true);
  const publish = vi
    .spyOn(GitHubApp.prototype, "publish")
    .mockResolvedValue("https://github.com/owner/private/pull/32");
  await runner.alarm();
  expect(publish).not.toHaveBeenCalled();
  expect(
    await DB.prepare(
      "SELECT json_extract(step_state, '$.pendingPublication.kind') AS kind FROM runs WHERE id = ?",
    )
      .bind(runId)
      .first("kind"),
  ).toBe("pushed");
  await runner.alarm();
  expect(verify).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(
    await DB.prepare("SELECT status FROM runs WHERE id = ?")
      .bind(runId)
      .first("status"),
  ).toBe("succeeded");
  expect(
    await DB.prepare("SELECT body FROM session_messages WHERE run_id = ?")
      .bind(runId)
      .first("body"),
  ).toBe("Done");
});

test("bounds failed ref reconciliation from its first check rather than the Run deadline", async (t) => {
  const { DB, runId, runner, setAlarm } = await preparedRun(t, "failed");
  vi.spyOn(GitHubApp.prototype, "hasCommit").mockRejectedValue(
    new Error("GitHub unavailable"),
  );
  const publish = vi.spyOn(GitHubApp.prototype, "publish");
  const before = Date.now();
  await runner.alarm();
  expect(setAlarm).toHaveBeenCalledTimes(1);
  const startedAt = await DB.prepare(
    "SELECT json_extract(step_state, '$.publicationStartedAt') AS at FROM runs WHERE id = ?",
  )
    .bind(runId)
    .first<number>("at");
  expect(startedAt).toBeGreaterThanOrEqual(before);
  await DB.prepare(
    "UPDATE runs SET step_state = json_set(step_state, '$.publicationStartedAt', ?) WHERE id = ?",
  )
    .bind(Date.now() - 31_000, runId)
    .run();
  await runner.alarm();
  expect(setAlarm).toHaveBeenCalledTimes(1);
  expect(publish).not.toHaveBeenCalled();
  expect(
    await DB.prepare(
      "SELECT status, error_code, next_action_at FROM runs WHERE id = ?",
    )
      .bind(runId)
      .first(),
  ).toStrictEqual({
    status: "failed",
    error_code: "publication_unconfirmed",
    next_action_at: null,
  });
});

test("reconciles a prepared push when the last Runner status request fails at the deadline", async (t) => {
  const { DB, runId, runner } = await preparedRun(t, "unavailable");
  await DB.prepare("UPDATE runs SET deadline_at = ? WHERE id = ?")
    .bind(Date.now() - 1, runId)
    .run();
  const verify = vi
    .spyOn(GitHubApp.prototype, "hasCommit")
    .mockResolvedValue(true);
  const publish = vi
    .spyOn(GitHubApp.prototype, "publish")
    .mockResolvedValue("https://github.com/owner/private/pull/32");
  await runner.alarm();
  expect(verify).toHaveBeenCalledTimes(1);
  expect(publish).not.toHaveBeenCalled();
  await runner.alarm();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(
    await DB.prepare("SELECT status FROM runs WHERE id = ?")
      .bind(runId)
      .first("status"),
  ).toBe("succeeded");
});

test("keeps polling after a temporary status failure before the prepared Run deadline", async (t) => {
  const { DB, runId, runner, setAlarm } = await preparedRun(t, "unavailable");
  const verify = vi.spyOn(GitHubApp.prototype, "hasCommit");
  const publish = vi.spyOn(GitHubApp.prototype, "publish");
  await runner.alarm();
  expect(verify).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(setAlarm).toHaveBeenCalledTimes(1);
  expect(
    await DB.prepare("SELECT status FROM runs WHERE id = ?")
      .bind(runId)
      .first("status"),
  ).toBe("running");
});

test("publishes the checked snapshot after the Runner is gone and cleans up its staged files", async (t) => {
  const { DB, RUN_ARTIFACTS } = await createTestBindings(t);
  const target = {
    repository: "owner/private",
    repositoryId: 42,
    installationId: 19,
    issueNumber: 8,
    defaultBranch: "main",
    triggerLabel: "tailos:run",
  };
  const { runId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "delivery",
    concurrencyKey: "target",
    ownerId: "owner",
    prompt: "Make changes",
    timeoutMs: 60_000,
    executionContext: JSON.stringify({
      version: 1,
      engine: "codex",
      connectionId: "codex/c42c7de5-938d-4f93-a6af-d43bb0e7b65c",
      repository: target,
    }),
  });
  const work = {
    kind: "checked" as const,
    branch: `tailos/issue-8/${runId}`,
    baseSha: "a".repeat(40),
    tree: "b".repeat(40),
    headline: "fix(api): validate input",
    reply: "Done",
    events: [{ type: "job_succeeded" as const, at: Date.now() }],
    changes: {
      additions: [{ path: "handler.ts", contents: "Cg==" }],
      deletions: [],
    },
  };
  const { branch, baseSha } = work;
  await DB.prepare(
    "UPDATE runs SET status = 'running', step_state = ? WHERE id = ?",
  )
    .bind(JSON.stringify({ version: 2, branch, baseSha }), runId)
    .run();

  const bearer = newRunLease();
  const values = new Map<string, unknown>([
    ["runId", runId],
    [
      "refreshLease",
      {
        runId,
        digest: await hashRunLease(bearer),
        expiresAt: Date.now() + 60_000,
      },
    ],
  ]);
  const storage = memoryStorage(values);
  const runner = new RunnerContainer(
    { storage } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {
      DB,
      RUN_ARTIFACTS,
      TAILOS_GH_APP_ID: "100",
      TAILOS_GH_APP_PRIVATE_KEY: "unused-test-key",
    },
  );
  expect(await runner.stagePublication(runId, newRunLease(), work)).toBe(false);
  expect(
    await runner.stagePublication(runId, bearer, {
      ...work,
      baseSha: "e".repeat(40),
    }),
  ).toBe(false);
  // Rejected attempts leave the Agent's GitHub access as it was.
  expect(values.has("agentEgressClosed")).toBe(false);
  expect(await runner.stagePublication(runId, bearer, work)).toBe(true);
  // Checked work is final: the egress Worker stops adding the Run's token
  // before the controller commits and opens the pull request.
  expect(values.get("agentEgressClosed")).toBe(true);
  expect(await runner.githubToken(runId)).toBeNull();
  expect(
    await runner.stagePublication(runId, bearer, {
      ...work,
      tree: "e".repeat(40),
    }),
  ).toBe(false);
  expect(
    await runner.stagePublication(runId, bearer, {
      kind: "prepared",
      branch,
      sha: "d".repeat(40),
      reply: "Legacy",
      events: [],
    }),
  ).toBe(false);

  const sha = "c".repeat(40);
  const commit = vi
    .spyOn(GitHubApp.prototype, "commitCheckedWork")
    .mockRejectedValueOnce(new Error("Signing response unavailable"))
    .mockResolvedValueOnce(sha);
  const url = "https://github.com/owner/private/pull/9";
  const publish = vi
    .spyOn(GitHubApp.prototype, "publish")
    .mockResolvedValue(url);
  t.onTestFinished(() => {
    commit.mockRestore();
    publish.mockRestore();
  });
  await runner.alarm();
  expect(publish).not.toHaveBeenCalled();
  await runner.alarm();
  // The stored context predates triggers and is read as a label trigger.
  const { issueNumber, triggerLabel, ...repository } = target;
  const trigger = {
    kind: "github.issue-label",
    issueNumber,
    label: triggerLabel,
  };
  expect(commit).toHaveBeenLastCalledWith(
    repository,
    trigger,
    runId,
    expect.objectContaining(work),
    expect.any(Number),
  );
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    repository,
    trigger,
    runId,
    {
      branch,
      sha,
      headline: work.headline,
    },
    expect.any(Number),
  );
  const stored = await DB.prepare(
    "SELECT status, result FROM runs WHERE id = ?",
  )
    .bind(runId)
    .first<{ status: string; result: string }>();
  expect(stored?.status).toBe("succeeded");
  expect(JSON.parse(stored!.result)).toMatchObject({
    kind: "pull_request",
    sha,
    branch,
    url,
  });
  const objects = await RUN_ARTIFACTS.list({
    prefix: `tailos-api/v1/runs/${runId}/`,
  });
  expect(objects.objects.map(({ key }) => key)).toEqual([
    `tailos-api/v1/runs/${runId}/execution.json`,
  ]);
});

test("planning refuses publication recovery and stops its container after saving questions", async (t) => {
  const DB = await createTestDb(t);
  const context = {
    version: 1,
    engine: "codex",
    mode: "plan",
    connectionId: "codex/c42c7de5-938d-4f93-a6af-d43bb0e7b65c",
    repository: {
      repository: "owner/private",
      repositoryId: 42,
      installationId: 19,
      issueNumber: 8,
      defaultBranch: "main",
      triggerLabel: "tailos:run",
    },
  };
  const { runId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "plan",
    concurrencyKey: "plan",
    ownerId: "owner",
    prompt: "Investigate",
    executionContext: JSON.stringify(context),
    timeoutMs: 60_000,
  });
  const pending = {
    kind: "checked",
    branch: `tailos/issue-8/${runId}`,
    baseSha: "a".repeat(40),
    tree: "b".repeat(40),
    headline: "fix: injected change",
    reply: "publish",
    events: [],
    digest: "c".repeat(64),
  };
  await DB.prepare(
    "UPDATE runs SET status = 'running', step_state = ? WHERE id = ?",
  )
    .bind(
      JSON.stringify({
        baseSha: pending.baseSha,
        branch: pending.branch,
        pendingPublication: pending,
      }),
      runId,
    )
    .run();
  const destroy = vi.fn(async () => {});
  const commit = vi.spyOn(GitHubApp.prototype, "commitCheckedWork");
  const publish = vi.spyOn(GitHubApp.prototype, "publish");
  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const runner = new RunnerContainer(
    {
      storage: memoryStorage(new Map([["runId", runId]]), async () => {
        throw new Error("Planning must end");
      }),
      container: {
        running: true,
        destroy,
        getTcpPort() {
          return {
            async fetch() {
              return Response.json({
                status: "succeeded",
                reply: "Which behavior?",
                plan: { planPresented: false, needsAnswer: true },
                events: [{ type: "job_succeeded", at: Date.now() }],
              });
            },
          };
        },
      },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    { DB },
  );
  await runner.alarm();
  expect(destroy).toHaveBeenCalledOnce();
  expect(commit).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(
    await DB.prepare("SELECT status FROM runs WHERE id = ?")
      .bind(runId)
      .first("status"),
  ).toBe("succeeded");
});

test.for([
  { largeIssue: false, oversized: false },
  { largeIssue: true, oversized: false },
  { largeIssue: false, oversized: true },
])(
  "passes an issue reference while retaining snapshots and diagnosing oversized conversation (%j)",
  async ({ largeIssue, oversized }, t) => {
    const { acceptPlanningInput, dispatchPlanningInputs } =
      await import("@/infrastructure/d1/planning.ts");
    const DB = await createTestDb(t);
    const requestBody =
      "@tailos plan\n" +
      (oversized ? "指".repeat(32_000) : "Details ".repeat(650));
    const target = {
      repository: "owner/repo",
      repositoryId: 1,
      installationId: 2,
      issueNumber: 3,
      defaultBranch: "main",
      triggerLabel: "tailos:run",
    };
    const { d1Projects } = await import("@/infrastructure/d1/projects.ts");
    const configured = await d1Projects(DB).create(
      {
        name: "Tailos",
        repository: "owner/repo",
        repositoryId: 1,
        installationId: 2,
        allowedActors: ["allowed"],
        maxRunMinutes: 1,
      },
      "owner",
    );
    await acceptPlanningInput(DB, {
      ownerId: "owner",
      projectId: configured.project.id,
      repositoryId: 1,
      issueNumber: 3,
      commentId: 100,
      actor: "allowed",
      url: "https://github.com/owner/repo/issues/3#issuecomment-100",
      body: requestBody,
      deliveryId: "plan",
      start: true,
      executionContext: JSON.stringify({
        version: 1,
        engine: "codex",
        mode: "plan",
        connectionId: `codex/${crypto.randomUUID()}`,
        repository: target,
      }),
      timeoutMs: 60_000,
    });
    const [runId] = await dispatchPlanningInputs(DB);
    const sessionId = await runSession(DB, runId!);
    const memory = new Map<string, unknown>([
      ["runId", runId],
      ["sessionId", sessionId],
    ]);
    const order: string[] = [];
    const controlKeys = new Set<string | null>();
    const jobs: string[] = [];
    const submit = vi.fn(async (_url: string, init?: RequestInit) => {
      if (_url.endsWith("/health"))
        return Response.json({ status: "ok", service: "runner" });
      controlKeys.add(new Headers(init?.headers).get("Authorization"));
      if (init?.method !== "POST")
        return Response.json({
          status: "succeeded",
          reply: "Plan",
          plan: { planPresented: true, needsAnswer: false },
          events: [],
        });
      jobs.push(String(init.body));
      const job = JSON.parse(String(init.body));
      expect(job.mode).toBe("plan");
      expect(job.githubContext).toMatchObject({
        kind: "issue",
        number: 3,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.parse(job.planningContext)).not.toHaveProperty("title");
      expect(JSON.parse(job.planningContext)).not.toHaveProperty("body");
      expect(String(init.body)).not.toContain("Current title");
      expect(String(init.body)).not.toContain("Current issue");
      expect(JSON.parse(job.planningContext).conversation[0].body).toBe(
        requestBody,
      );
      expect(job.checkout.baseSha).toBe("a".repeat(40));
      // The GitHub token stays outside the container.
      expect(job.checkout).not.toHaveProperty("token");
      expect(String(init.body)).not.toContain("read-token");

      return Response.json(
        {
          status: "succeeded",
          reply: "Plan",
          plan: { planPresented: true, needsAnswer: false },
          events: [],
        },
        { status: 202 },
      );
    });
    const start = vi.fn(() => {
      order.push("start");
    });
    const interceptOutboundHttps = vi.fn(async (host: string) => {
      order.push(host);
    });
    const egress = vi.fn((options: unknown) => options);
    let closedAtDestroy: unknown;
    const destroy = vi.fn(async () => {
      closedAtDestroy = memory.get("agentEgressClosed");
    });
    vi.spyOn(GitHubApp.prototype, "checkout").mockResolvedValue({
      token: "read-token",
      expiresAt: Date.now() + 60_000,
      baseSha: "a".repeat(40),
      branch: `tailos/issue-3/${runId}`,
      issueSnapshot: {
        title: "Current title",
        body: largeIssue ? "長".repeat(32_000) : "Current issue",
      },
    });
    vi.spyOn(GitHubApp.prototype, "revoke").mockResolvedValue();
    t.onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const runner = new RunnerContainer(
      {
        storage: memoryStorage(memory),
        container: {
          images: { runner: "image" },
          start,
          interceptOutboundHttps,
          running: true,
          async setInactivityTimeout() {},
          getTcpPort: () => ({ fetch: submit }),
          destroy,
        },
        exports: { GitHubEgress: egress, ModelEgress: egress },
      } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
      {
        DB,
        TAILOS_GH_APP_ID: "100",
        TAILOS_GH_APP_PRIVATE_KEY: "unused",
        TAILOS_PUBLIC_ORIGIN: "https://api.tailos.app",
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        CREDENTIALS: {
          getByName: () => ({
            issueAccess: async () => ({
              accessToken: "access",
              accountId: "account",
              connectionVersion: crypto.randomUUID(),
              accessVersion: crypto.randomUUID(),
            }),
          }),
        },
      } as unknown as ConstructorParameters<typeof RunnerContainer>[1],
    );
    await runner.alarm();
    if (!oversized) await runner.alarm();
    expect(
      await DB.prepare("SELECT title FROM planning_snapshots").first("title"),
    ).toBe("Current title");
    expect(await DB.prepare("SELECT status FROM runs").first("status")).toBe(
      oversized ? "failed" : "succeeded",
    );
    if (oversized) {
      expect(start).not.toHaveBeenCalled();
      expect(
        await DB.prepare("SELECT error_code FROM runs").first("error_code"),
      ).toBe("planning_input_too_large");
    } else {
      expect(start).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ enableInternet: true }),
      );
      // HTTPS intercepts exist before the container starts.
      expect(order).toEqual([
        "github.com",
        "api.github.com",
        "chatgpt.com",
        "start",
      ]);
      // The egress Workers ask the Session for its current Run.
      expect(egress).toHaveBeenCalledWith({ props: { sessionId } });
      // The Codex token stays outside too: Codex gets a placeholder that
      // carries only the account.
      expect(jobs).toHaveLength(1);
      const job = JSON.parse(jobs[0]!);
      expect(job.access.accessToken).not.toBe("access");
      const [, claims] = job.access.accessToken.split(".");
      expect(
        JSON.parse(Buffer.from(claims, "base64url").toString())[
          "https://api.openai.com/auth"
        ].chatgpt_account_id,
      ).toBe("account");
      expect(job.access.accountId).toBe("account");
      expect(job.refresh.url).toBe(
        `https://api.tailos.app/_runner/runs/${runId}/`,
      );
      expect([...controlKeys]).toEqual([
        expect.stringMatching(/^Bearer [a-f0-9]{64}$/),
      ]);
      // The controller keeps its key for the Session's container: a new
      // Runner takes the first key it is sent.
      expect(memory.has("runnerKey")).toBe(true);
      // Planning results arrived: the Agent's GitHub access ended before them.
      expect(closedAtDestroy).toBe(true);
      expect(memory.has("agentEgressClosed")).toBe(false);
    }
    expect(
      await DB.prepare("SELECT body FROM planning_snapshots").first("body"),
    ).toBe(largeIssue ? "長".repeat(32_000) : "Current issue");
    expect(destroy).toHaveBeenCalledOnce();
    expect(
      await DB.prepare("SELECT count(*) AS n FROM planning_replies").first("n"),
    ).toBe(1);
  },
);

test("hands the Run's GitHub token only to its own unexpired grant", async () => {
  const runId = crypto.randomUUID();
  const key = Buffer.alloc(32, 7).toString("base64");
  const memory = new Map<string, unknown>([
    ["runId", runId],
    [
      "repositoryGrant",
      {
        value: await seal("run-token", key, `tailos:github:${runId}`),
        expiresAt: Date.now() + 60_000,
        attempts: 0,
      },
    ],
  ]);
  const runner = new RunnerContainer(
    {
      storage: { get: async (name: string) => memory.get(name) },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    { CREDENTIAL_ENCRYPTION_KEY: key } as ConstructorParameters<
      typeof RunnerContainer
    >[1],
  );
  expect(await runner.githubToken(runId)).toBe("run-token");
  // The egress Workers of a kept container ask for the current Run's token.
  expect(await runner.githubToken()).toBe("run-token");
  expect(await runner.githubToken(crypto.randomUUID())).toBeNull();
  // Once the Agent's work is over, publication must not race its processes.
  memory.set("agentEgressClosed", true);
  expect(await runner.githubToken(runId)).toBeNull();
  memory.delete("agentEgressClosed");
  memory.set("repositoryGrant", {
    ...(memory.get("repositoryGrant") as object),
    expiresAt: Date.now() - 1,
  });
  expect(await runner.githubToken(runId)).toBeNull();
  memory.delete("repositoryGrant");
  expect(await runner.githubToken(runId)).toBeNull();
});

/** A bucket that keeps objects as text, for the saved work of a Session. */
function memoryBucket(objects: Map<string, string>) {
  return {
    get: vi.fn(async (key: string) => {
      const value = objects.get(key);
      return value === undefined
        ? null
        : { text: async () => value, body: new Response(value).body };
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      objects.set(key, await new Response(value as BodyInit).text());
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
}

test.for([
  { name: "its snapshot", snapshotImage: "image", fromSnapshot: true },
  {
    name: "the image after an update",
    snapshotImage: "old-image",
    fromSnapshot: false,
  },
])(
  "continues a Session's Turn from its saved work and $name, and keeps the new work",
  async ({ snapshotImage, fromSnapshot }, t) => {
    const DB = await createTestDb(t);
    const { runId, sessionId } = await admitTrigger(DB, {
      source: "test",
      idempotencyKey: "continuity",
      ownerId: "owner",
      concurrencyKey: "target",
      prompt: "Keep going",
      executionContext: JSON.stringify({
        version: 1,
        engine: "codex",
        connectionId: `codex/${crypto.randomUUID()}`,
        repository: {
          repository: "owner/repo",
          repositoryId: 1,
          installationId: 2,
          defaultBranch: "main",
        },
        trigger: { kind: "web.message" },
      }),
      timeoutMs: 60_000,
    });
    const savedBase = "b".repeat(40);
    const previousKey = `sessions/v1/${sessionId}/continuity/previous`;
    const objects = new Map([[previousKey, "previous work"]]);
    const bucket = memoryBucket(objects);
    const memory = new Map<string, unknown>([
      ["sessionId", sessionId],
      [
        "continuity",
        {
          key: previousKey,
          baseSha: savedBase,
          snapshot: { id: "snapshot-0", image: snapshotImage },
        },
      ],
    ]);
    const requests: string[] = [];
    let collected = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/health")
        return Response.json({ status: "ok", service: "runner" });
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/continuity") {
        expect(await new Response(init?.body).text()).toBe("previous work");
        return new Response(null, { status: 204 });
      }
      if (path === "/job") {
        const job = JSON.parse(String(init?.body));
        expect(job.continuity).toStrictEqual({ restore: "saved" });
        // The saved work continues on its own base, not the latest branch.
        expect(job.checkout.baseSha).toBe(savedBase);
        return new Response(null, { status: 202 });
      }
      if (path === `/job/${runId}`)
        return Response.json({
          status: "failed",
          errorCode: "agent_failed",
          events: [],
        });
      if (path === `/job/${runId}/continuity`) {
        // The Runner may still be packing the work when the Turn has ended.
        if (collected++ === 0) return Response.json({}, { status: 202 });
        return new Response("next work", {
          headers: { "Content-Length": "9" },
        });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const checkout = vi
      .spyOn(GitHubApp.prototype, "checkout")
      .mockResolvedValue({
        token: "write-token",
        expiresAt: Date.now() + 60_000,
        baseSha: "a".repeat(40),
        branch: `tailos/run/${runId}`,
      });
    vi.spyOn(GitHubApp.prototype, "revoke").mockResolvedValue();
    t.onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const destroy = vi.fn(async () => {});
    const start = vi.fn((_options: unknown) => {});
    const snapshotContainer = vi.fn(async () => ({
      id: "snapshot-1",
      size: 1,
    }));
    const runner = new RunnerContainer(
      {
        storage: memoryStorage(memory),
        container: {
          images: { runner: "image" },
          start,
          interceptOutboundHttps: async () => {},
          running: true,
          async setInactivityTimeout() {},
          getTcpPort: () => ({ fetch }),
          inspect: async () => ({ image: "image", labels: {} }),
          snapshotContainer,
          destroy,
        },
        exports: { GitHubEgress: () => ({}), ModelEgress: () => ({}) },
      } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
      {
        DB,
        RUN_ARTIFACTS: bucket,
        TAILOS_GH_APP_ID: "100",
        TAILOS_GH_APP_PRIVATE_KEY: "unused",
        TAILOS_PUBLIC_ORIGIN: "https://api.tailos.app",
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        CREDENTIALS: {
          getByName: () => ({
            issueAccess: async () => ({
              accessToken: "access",
              accountId: "account",
              connectionVersion: crypto.randomUUID(),
              accessVersion: crypto.randomUUID(),
            }),
          }),
        },
      } as unknown as ConstructorParameters<typeof RunnerContainer>[1],
    );

    await runner.schedule(runId, sessionId);
    await runner.alarm();
    expect(checkout).toHaveBeenCalledOnce();
    // A snapshot of another image would silently run the older Runner.
    expect(start).toHaveBeenCalledExactlyOnceWith(
      fromSnapshot
        ? expect.objectContaining({ containerSnapshot: { id: "snapshot-0" } })
        : expect.objectContaining({ image: "image" }),
    );
    // The previous work reaches the Runner before the job that continues it.
    expect(requests).toStrictEqual(["PUT /continuity", "POST /job"]);
    await runner.alarm();

    expect(destroy).toHaveBeenCalledOnce();
    const savedKey = `sessions/v1/${sessionId}/continuity/${runId}`;
    expect(objects.get(savedKey)).toBe("next work");
    // The new snapshot holds the saved work, for the image it was taken from.
    expect(snapshotContainer).toHaveBeenCalledOnce();
    expect(memory.get("continuity")).toStrictEqual({
      key: savedKey,
      baseSha: savedBase,
      snapshot: { id: "snapshot-1", image: "image" },
    });
    // Only the latest work of the Session is kept.
    expect(objects.has(previousKey)).toBe(false);
    expect(memory.has("continuityRun")).toBe(false);
  },
);

test.for([
  {
    name: "records lost work when the Runner could not save it",
    respond: () => Response.json({}, { status: 410 }),
    record: { lost: true },
    kept: false,
  },
  {
    name: "records lost work when the Runner cannot be reached",
    respond: () => {
      throw new Error("Runner unavailable");
    },
    record: { lost: true },
    kept: false,
  },
  {
    name: "records lost work when the Runner lost its job",
    respond: () => Response.json({}, { status: 404 }),
    record: { lost: true },
    kept: false,
  },
  {
    name: "records lost work when the container is gone",
    respond: () => new Response(null, { status: 204 }),
    record: { lost: true },
    kept: false,
    running: false,
  },
  {
    name: "keeps the previous work when the Turn never reached it",
    respond: () => new Response(null, { status: 204 }),
    record: {
      key: "sessions/v1/session/continuity/previous",
      baseSha: "b".repeat(40),
    },
    kept: true,
  },
])("$name", async ({ respond, record, kept, running = true }, t) => {
  const { DB } = await createTestBindings(t);
  const { runId, sessionId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "saving",
    ownerId: "owner",
    concurrencyKey: "target",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  });
  await DB.prepare(
    "UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?",
  )
    .bind(Date.now(), runId)
    .run();
  const previousKey = "sessions/v1/session/continuity/previous";
  const objects = new Map([[previousKey, "previous work"]]);
  const memory = new Map<string, unknown>([
    ["runId", runId],
    ["sessionId", sessionId],
    ["continuity", { key: previousKey, baseSha: "b".repeat(40) }],
    ["continuityRun", { runId, baseSha: "b".repeat(40) }],
  ]);
  const fetch = vi.fn(async () => respond());
  const runner = new RunnerContainer(
    {
      storage: memoryStorage(memory),
      container: {
        running,
        getTcpPort: () => ({ fetch }),
        destroy: async () => {},
      },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {
      DB,
      RUN_ARTIFACTS: memoryBucket(objects),
    } as unknown as ConstructorParameters<typeof RunnerContainer>[1],
  );
  await runner.alarm();
  expect(memory.get("continuity")).toStrictEqual(record);
  expect(objects.has(previousKey)).toBe(kept);
  // Failed attempts are retried a few times, never without end.
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(3);
});

test("keeps a saved Session's container waiting for its next Turn, then ends it", async (t) => {
  const { DB } = await createTestBindings(t);
  const { runId, sessionId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "idle",
    ownerId: "owner",
    concurrencyKey: "target",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  });
  await DB.prepare(
    "UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?",
  )
    .bind(Date.now(), runId)
    .run();
  const memory = new Map<string, unknown>([
    ["runId", runId],
    ["sessionId", sessionId],
    ["continuityRun", { runId, baseSha: "b".repeat(40) }],
  ]);
  const setAlarm = vi.fn(async (_at: number) => {});
  const destroy = vi.fn(async () => {});
  class WaitingRunner extends RunnerContainer {
    protected override idleMs = 60_000;
  }
  const runner = new WaitingRunner(
    {
      storage: memoryStorage(memory, setAlarm),
      container: {
        running: true,
        images: { runner: "image" },
        getTcpPort: () => ({
          fetch: async () =>
            new Response("work", { headers: { "Content-Length": "4" } }),
        }),
        snapshotContainer: async () => ({ id: "snapshot", size: 1 }),
        destroy,
      },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {
      DB,
      RUN_ARTIFACTS: memoryBucket(new Map()),
    } as unknown as ConstructorParameters<typeof RunnerContainer>[1],
  );
  await runner.alarm();
  expect(destroy).not.toHaveBeenCalled();
  const idleUntil = memory.get("idleUntil") as number;
  expect(idleUntil).toBeGreaterThan(Date.now());
  expect(setAlarm).toHaveBeenLastCalledWith(idleUntil);

  // Without a next Turn in time, the container goes.
  memory.set("idleUntil", Date.now() - 1);
  await runner.alarm();
  expect(destroy).toHaveBeenCalledOnce();
  expect(memory.has("idleUntil")).toBe(false);
});

test("keeps the saved work when the Run's cleanup is retried", async (t) => {
  const { DB } = await createTestBindings(t);
  const { runId, sessionId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "retried-cleanup",
    ownerId: "owner",
    concurrencyKey: "target",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  });
  await DB.prepare(
    "UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?",
  )
    .bind(Date.now(), runId)
    .run();
  const memory = new Map<string, unknown>([
    ["runId", runId],
    ["sessionId", sessionId],
    ["continuityRun", { runId, baseSha: "b".repeat(40) }],
    [
      "repositoryGrant",
      { value: {}, expiresAt: Date.now() + 60_000, attempts: 0 },
    ],
  ]);
  const container = {
    running: true,
    images: { runner: "image" },
    snapshotContainer: async () => ({ id: "snapshot", size: 1 }),
    getTcpPort: () => ({
      fetch: async () =>
        new Response("work", { headers: { "Content-Length": "4" } }),
    }),
    destroy: async () => {
      container.running = false;
    },
  };
  // Without the GitHub App the revocation fails and the cleanup is retried.
  const runner = new RunnerContainer(
    {
      storage: memoryStorage(memory),
      container,
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {
      DB,
      RUN_ARTIFACTS: memoryBucket(new Map()),
    } as unknown as ConstructorParameters<typeof RunnerContainer>[1],
  );
  await runner.alarm();
  const saved = {
    key: `sessions/v1/${sessionId}/continuity/${runId}`,
    baseSha: "b".repeat(40),
    snapshot: { id: "snapshot", image: "image" },
  };
  expect(memory.get("continuity")).toStrictEqual(saved);
  expect(memory.get("runId")).toBe(runId);
  await runner.alarm();
  expect(memory.get("continuity")).toStrictEqual(saved);
});

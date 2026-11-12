import { expect, test, vi } from "vitest";

import {
  createTestBindings,
  createTestDb,
} from "@/infrastructure/d1/testing.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { hashRunLease, newRunLease } from "@/infrastructure/auth/run-lease.ts";
import { GitHubApp } from "@/infrastructure/github/app.ts";
import { RunnerContainer } from "@/infrastructure/cloudflare/runner-container.ts";
import type { DiagnosticBatch } from "@tailos/core/diagnostics";
import { registerDiagnosticProducer } from "@/infrastructure/diagnostics/store.ts";

test("a diagnostics lease accepts late telemetry but cannot publish or refresh credentials", async (t) => {
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
          return key === "diagnosticLease" ? lease : undefined;
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
  expect(
    await runner.refreshAccess(runId, bearer, crypto.randomUUID()),
  ).toBeNull();
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

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: DurableObjectState,
      protected env: unknown,
    ) {}
  },
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
  const ctx = {
    storage: {
      async get(key: string) {
        return key === "runId" ? runId : undefined;
      },
      async delete(_key: string) {},
      setAlarm,
    },
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
  return { DB, runId, runner, target, pending, setAlarm };
}

test.for(["failed", "lost"] as const)(
  "ends a prepared publication promptly when the Runner is %s and its commit was not pushed",
  async (state, t) => {
    const { DB, runId, runner, setAlarm } = await preparedRun(t, state);
    const verify = vi
      .spyOn(GitHubApp.prototype, "hasCommit")
      .mockResolvedValue(false);
    const publish = vi.spyOn(GitHubApp.prototype, "publish");
    await runner.alarm();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(setAlarm).not.toHaveBeenCalled();
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
  const records = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async delete(key: string) {
      return values.delete(key);
    },
  };
  const storage = {
    ...records,
    async transaction<T>(
      fn: (store: typeof records) => Promise<T>,
    ): Promise<T> {
      return fn(records);
    },
    async setAlarm() {},
  };
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
  expect(await runner.stagePublication(runId, bearer, work)).toBe(true);
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
  expect(commit).toHaveBeenLastCalledWith(
    target,
    runId,
    expect.objectContaining(work),
    expect.any(Number),
  );
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    target,
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

test("egress initialization fails closed before container startup", async () => {
  const start = vi.fn();
  const intercept = vi
    .fn()
    .mockRejectedValue(new Error("intercept unavailable"));
  const runner = new RunnerContainer(
    {
      storage: { get: async () => undefined },
      exports: { RunnerEgress: {}, DependencyEgress: {} },
      container: {
        images: { runner: "image" },
        start,
        interceptOutboundHttps: intercept,
      },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {} as ConstructorParameters<typeof RunnerContainer>[1],
  );
  await expect(runner["startRunner"](Date.now() + 1_000, true)).rejects.toThrow(
    "intercept unavailable",
  );
  expect(start).not.toHaveBeenCalled();
});

test("only the Runner lease can permanently close dependency egress", async () => {
  const bearer = newRunLease();
  const lease = {
    runId: "run",
    expiresAt: Date.now() + 60_000,
    digest: await hashRunLease(bearer),
  };
  const put = vi.fn();
  const intercept = vi.fn();
  const handler = {};
  const runner = new RunnerContainer(
    {
      storage: { get: async () => lease, put },
      exports: { RunnerEgress: handler },
      container: { interceptOutboundHttps: intercept },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {} as ConstructorParameters<typeof RunnerContainer>[1],
  );
  expect(await runner.closeDependencyNetwork("run", newRunLease())).toBe(false);
  expect(await runner.closeDependencyNetwork("other", bearer)).toBe(false);
  expect(intercept).not.toHaveBeenCalled();
  expect(await runner.closeDependencyNetwork("run", bearer)).toBe(true);
  expect(put).toHaveBeenCalledWith("dependencyNetworkClosed", true);
  expect(intercept).toHaveBeenCalledExactlyOnceWith(
    "registry.npmjs.org",
    handler,
  );
  lease.expiresAt = 0;
  expect(await runner.closeDependencyNetwork("run", bearer)).toBe(false);
});

test.each([false, true])(
  "starts with Internet disabled and preserves closed dependency state (%s)",
  async (closed) => {
    const handler = {};
    const dependencyHandler = {};
    const order: string[] = [];
    const start = vi.fn(() => {
      order.push("start");
    });
    const https = vi.fn(async () => {
      order.push("https");
    });
    const runner = new RunnerContainer(
      {
        storage: { get: async () => closed },
        exports: { RunnerEgress: handler, DependencyEgress: dependencyHandler },
        container: {
          images: { runner: "image" },
          start,
          interceptOutboundHttps: https,
          interceptAllOutboundHttp: async () => {
            order.push("http");
          },
          setInactivityTimeout: async () => {},
          getTcpPort: () => ({
            fetch: async () =>
              Response.json({ status: "ok", service: "runner" }),
          }),
        },
      } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
      {} as ConstructorParameters<typeof RunnerContainer>[1],
    );
    await runner["startRunner"](Date.now() + 10_000, true);
    expect(https).toHaveBeenNthCalledWith(
      1,
      "registry.npmjs.org",
      closed ? handler : dependencyHandler,
    );
    expect(https).toHaveBeenNthCalledWith(2, "*", handler);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        enableInternet: false,
        env: { TAILOS_REQUIRE_EGRESS_CA: "1" },
      }),
    );
    expect(order).toEqual(["https", "http", "https", "start"]);
  },
);

import { expect, test, vi } from "vitest";

import {
  createTestBindings,
  createTestDb,
} from "@/infrastructure/d1/testing.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { hashRunLease, newRunLease } from "@/infrastructure/auth/run-lease.ts";
import { GitHubApp } from "@/infrastructure/github/app.ts";
import {
  implementationPrompt,
  legacyImplementationPrompt,
} from "@/application/routines/routines.ts";
import {
  maxPushedBranches,
  placeholderClaudeToken,
  RunnerContainer,
} from "@/infrastructure/cloudflare/runner-container.ts";
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

test("a diagnostics lease accepts late telemetry but cannot obtain model access", async (t) => {
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
  for (const key of ["runId", "agentEgressClosed"])
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

test("a Claude Turn gets a placeholder token, and only its egress gets the real one", async () => {
  const runId = crypto.randomUUID();
  const values = new Map<string, unknown>();
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
  };
  const issueClaudeAccess = vi.fn(async () => ({
    token: "sk-ant-oat01-real",
    connectionVersion: "connection-1",
  }));
  const issueAccess = vi.fn();
  const getByName = vi.fn(() => ({ issueClaudeAccess, issueAccess }));
  const runner = new RunnerContainer(
    { storage } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {
      TAILOS_PUBLIC_ORIGIN: "https://tailos.example",
      CREDENTIALS: { getByName },
    } as never,
  );
  const connectionId = `claude/${crypto.randomUUID()}`;
  const job = await (
    runner as unknown as {
      prepareJob(request: unknown): Promise<Record<string, unknown>>;
    }
  ).prepareJob({
    runId,
    prompt: "Fix the bug",
    deadlineAt: Date.now() + 600_000,
    context: {
      version: 1,
      engine: "claude",
      connectionId,
      model: "claude-opus-5-5",
      effort: "max",
      // A Session started before the Agent opened pull requests itself.
      instructions: legacyImplementationPrompt,
    },
  });

  expect(getByName).toHaveBeenCalledWith(connectionId);
  expect(job).toMatchObject({
    prompt: implementationPrompt,
    message: "Fix the bug",
    engine: "claude",
    model: "claude-opus-5-5",
    effort: "max",
    access: {
      token: placeholderClaudeToken,
      connectionVersion: "connection-1",
    },
  });
  // Nothing calls back into the controller: the Runner gets no lease.
  expect(job).not.toHaveProperty("lease");
  expect(JSON.stringify(job)).not.toContain("sk-ant-oat01-real");
  expect(issueAccess).not.toHaveBeenCalled();

  expect(await runner.claudeAccess(runId)).toBe("sk-ant-oat01-real");
  // The Codex host gets nothing while a Claude Turn runs.
  expect(await runner.modelAccess(runId)).toBeNull();
  expect(await runner.claudeAccess(crypto.randomUUID())).toBeNull();
  issueClaudeAccess.mockResolvedValueOnce({
    token: "sk-ant-oat01-new",
    connectionVersion: "connection-2",
  });
  // A connection saved again after the Turn started is not this Turn's.
  expect(await runner.claudeAccess(runId)).toBeNull();
  values.set("agentEgressClosed", true);
  expect(await runner.claudeAccess(runId)).toBeNull();
});

test("a Codex Turn's egress adds no Claude token", async () => {
  const runId = crypto.randomUUID();
  const values = new Map<string, unknown>([
    [
      "refreshLease",
      {
        digest: "digest",
        runId,
        connectionId: "codex/connection",
        connectionVersion: "connection-1",
        expiresAt: Date.now() + 600_000,
        lastRefreshAt: 0,
      },
    ],
  ]);
  const issueClaudeAccess = vi.fn();
  const runner = new RunnerContainer(
    {
      storage: { get: async (key: string) => values.get(key) },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    { CREDENTIALS: { getByName: () => ({ issueClaudeAccess }) } } as never,
  );
  expect(await runner.claudeAccess(runId)).toBeNull();
  expect(issueClaudeAccess).not.toHaveBeenCalled();
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

async function pushingRun(t: import("vitest").TestContext) {
  const DB = await createTestDb(t);
  const repository = {
    repository: "owner/private",
    repositoryId: 42,
    installationId: 19,
    defaultBranch: "main",
  };
  const trigger = {
    kind: "github.issue-label",
    issueNumber: 8,
    label: "tailos:run",
  } as const;
  const { runId, sessionId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "pushing",
    concurrencyKey: "target",
    ownerId: "owner",
    prompt: "Make changes",
    timeoutMs: 30 * 60_000,
    executionContext: JSON.stringify({
      version: 1,
      engine: "codex",
      connectionId: "codex/c42c7de5-938d-4f93-a6af-d43bb0e7b65c",
      repository,
      trigger,
    }),
  });
  await DB.prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .bind(runId)
    .run();
  const stored = new Map<string, unknown>([
    ["runId", runId],
    ["sessionId", sessionId],
  ]);
  const runner = new RunnerContainer(
    {
      storage: memoryStorage(stored),
      container: {
        running: true,
        destroy: vi.fn(async () => {}),
        getTcpPort: () => ({
          fetch: async () =>
            Response.json({
              status: "succeeded",
              reply: "Done",
              events: [{ type: "job_succeeded", at: Date.now() }],
            }),
        }),
      },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {
      DB,
      TAILOS_GH_APP_ID: "100",
      TAILOS_GH_APP_PRIVATE_KEY: "unused-test-key",
    } as unknown as ConstructorParameters<typeof RunnerContainer>[1],
  );
  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });
  return { DB, runId, runner, stored, repository };
}

test("records the branches a Run pushes only while it works", async (t) => {
  const { runner, runId, stored } = await pushingRun(t);
  const repo = "owner/private";
  await runner.recordPush(runId, repo, ["feature", "fix"]);
  await runner.recordPush(undefined, repo, ["fix", "docs"]);
  // Another Run's pushes, or pushes after the work is over, are not this
  // Run's.
  await runner.recordPush(crypto.randomUUID(), repo, ["other"]);
  expect(stored.get("pushedBranches")).toEqual(
    ["feature", "fix", "docs"].map((branch) => ({ repository: repo, branch })),
  );
  await runner.recordPush(
    runId,
    repo,
    Array.from({ length: 30 }, (_, i) => `many-${i}`),
  );
  expect(stored.get("pushedBranches")).toHaveLength(maxPushedBranches);
  stored.set("agentEgressClosed", true);
  stored.delete("pushedBranches");
  await runner.recordPush(runId, repo, ["late"]);
  expect(stored.has("pushedBranches")).toBe(false);
});

test("a Turn's result is the pull requests of the branches it pushed", async (t) => {
  const { DB, runner, runId, stored, repository } = await pushingRun(t);
  const url = "https://github.com/owner/private/pull/1";
  const lookup = vi
    .spyOn(GitHubApp.prototype, "branchPullRequests")
    .mockResolvedValue([{ branch: "feature", url }]);
  await runner.recordPush(runId, "Owner/Private", ["feature"]);
  await runner.recordPush(runId, "owner/private", ["no-pull-request"]);
  // A push to another repository is not this Run's work in its target.
  await runner.recordPush(runId, "other/repo", ["elsewhere"]);

  await runner.alarm();
  expect(lookup).toHaveBeenCalledExactlyOnceWith(repository, [
    "feature",
    "no-pull-request",
  ]);
  const run = await DB.prepare("SELECT status, result FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ status: string; result: string }>();
  expect(run?.status).toBe("succeeded");
  expect(JSON.parse(run!.result)).toMatchObject({
    kind: "pull_requests",
    pullRequests: [{ branch: "feature", url }],
  });
  // The next Run of the Session starts with nothing recorded.
  expect(stored.has("pushedBranches")).toBe(false);
});

test("a Turn that pushed nothing, or whose pull requests cannot be read, is completed", async (t) => {
  const { DB, runner, runId } = await pushingRun(t);
  const lookup = vi
    .spyOn(GitHubApp.prototype, "branchPullRequests")
    .mockRejectedValue(new Error("GitHub unavailable"));
  await runner.recordPush(runId, "owner/private", ["feature"]);

  await runner.alarm();
  expect(lookup).toHaveBeenCalledOnce();
  const run = await DB.prepare("SELECT status, result FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ status: string; result: string }>();
  expect(run?.status).toBe("succeeded");
  expect(JSON.parse(run!.result)).toMatchObject({ kind: "completed" });
});

test.for([{ oversized: false }, { oversized: true }])(
  "gives a plan Turn the Routine's prompt, the comment and an issue reference, and fails a comment too long for a job (%j)",
  async ({ oversized }, t) => {
    const { admitIssueMessage } =
      await import("@/infrastructure/d1/session-inbox.ts");
    const { d1Routines } = await import("@/infrastructure/d1/routines.ts");
    const { planningPrompt } =
      await import("@/application/routines/routines.ts");
    const DB = await createTestDb(t);
    const requestBody =
      "@tailos plan\n" +
      (oversized ? "指".repeat(32_000) : "Details ".repeat(650));
    const { d1Projects } = await import("@/infrastructure/d1/projects.ts");
    const configured = await d1Projects(DB).create(
      {
        name: "Tailos",
        repository: "owner/repo",
        repositoryId: 1,
        installationId: 2,
        maxRunMinutes: 1,
      },
      "owner",
    );
    const routine = (await d1Routines(DB).save("owner", configured.project.id, {
      name: "Planning",
      enabled: true,
      trigger: { version: 1, type: "github.issue-comment", command: "plan" },
      allowedActors: ["allowed"],
      engine: "codex",
      prompt: planningPrompt,
    }))!;
    const contentHash = "c".repeat(64);
    const receipt = await admitIssueMessage(DB, {
      source: "github.issue-comment",
      idempotencyKey: "comment-100",
      deliveryId: "plan",
      ownerId: "owner",
      projectId: configured.project.id,
      projectRevision: 1,
      routineId: routine.id,
      routineRevision: 1,
      repositoryId: 1,
      issueNumber: 3,
      startsSession: true,
      initialTitle: "Issue",
      triggerMetadata: "{}",
      target: "{}",
      body: requestBody,
      executionContext: JSON.stringify({
        version: 1,
        engine: "codex",
        mode: "plan",
        instructions: planningPrompt,
        connectionId: `codex/${crypto.randomUUID()}`,
        repository: {
          repository: "owner/repo",
          repositoryId: 1,
          installationId: 2,
          defaultBranch: "main",
        },
        trigger: {
          kind: "github.issue-comment",
          issueNumber: 3,
          issueContentHash: contentHash,
        },
      }),
      timeoutMs: 60_000,
    });
    const runId = receipt!.runId;
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
      expect(job.githubContext).toEqual({
        kind: "issue",
        number: 3,
        contentHash,
      });
      // The Routine says what to do; the comment is the message.
      expect(job.prompt).toBe(planningPrompt);
      expect(job.message).toBe(requestBody);
      // A plan Session keeps its conversation like any other.
      expect(job.continuity).toEqual({});
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
      author: {
        name: "tailos-app[bot]",
        email: "1+tailos-app[bot]@users.noreply.github.com",
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
    expect(await DB.prepare("SELECT status FROM runs").first("status")).toBe(
      oversized ? "failed" : "succeeded",
    );
    if (oversized) {
      expect(start).not.toHaveBeenCalled();
      expect(
        await DB.prepare("SELECT error_code FROM runs").first("error_code"),
      ).toBe("message_too_large");
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
        "api.anthropic.com",
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
      // The Runner gets no lease: nothing calls back into the controller.
      expect(job.refresh).toBeUndefined();
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
    expect(destroy).toHaveBeenCalledOnce();
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
  {
    name: "its snapshot",
    snapshotImage: "image",
    fromSnapshot: true,
  },
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
        // The saved work continues on its own base, not the latest branch,
        // even after a pull request of the Session merged.
        expect(job.checkout).toStrictEqual({
          repository: "owner/repo",
          baseSha: savedBase,
          defaultBranch: "main",
          author: {
            name: "tailos-app[bot]",
            email: "1+tailos-app[bot]@users.noreply.github.com",
          },
        });
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
        author: {
          name: "tailos-app[bot]",
          email: "1+tailos-app[bot]@users.noreply.github.com",
        },
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

test("keeps a waiting container when the Run's cleanup is retried", async (t) => {
  const { DB } = await createTestBindings(t);
  const { runId, sessionId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "retried-waiting-cleanup",
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
  const destroy = vi.fn(async () => {});
  class WaitingRunner extends RunnerContainer {
    protected override idleMs = 60_000;
  }
  // Without the GitHub App the revocation fails and the cleanup is retried.
  const runner = new WaitingRunner(
    {
      storage: memoryStorage(memory),
      container: {
        running: true,
        images: { runner: "image" },
        snapshotContainer: async () => ({ id: "snapshot", size: 1 }),
        getTcpPort: () => ({
          fetch: async () =>
            new Response("work", { headers: { "Content-Length": "4" } }),
        }),
        destroy,
      },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {
      DB,
      RUN_ARTIFACTS: memoryBucket(new Map()),
    } as unknown as ConstructorParameters<typeof RunnerContainer>[1],
  );
  await runner.alarm();
  const idleUntil = memory.get("idleUntil") as number;
  expect(idleUntil).toBeGreaterThan(Date.now());
  expect(memory.get("runId")).toBe(runId);
  await runner.alarm();
  expect(destroy).not.toHaveBeenCalled();
  expect(memory.get("idleUntil")).toBe(idleUntil);
});

/** A container that records how the Runner was started, and is always ready. */
function startingContainer(inspected: string, idle = false) {
  const order: string[] = [];
  const container = {
    running: idle,
    images: { runner: "image" },
    async interceptOutboundHttps(host: string) {
      order.push(`intercept ${host}`);
    },
    start(options: { image?: string; containerSnapshot?: { id: string } }) {
      container.running = true;
      order.push(options.image ? "start image" : "start snapshot");
    },
    async inspect() {
      return { image: inspected, labels: {} };
    },
    async destroy() {
      container.running = false;
      order.push("destroy");
    },
    async setInactivityTimeout() {},
    getTcpPort: () => ({
      fetch: async () => Response.json({ status: "ok", service: "runner" }),
    }),
  };
  return { container, order };
}

type Starting = {
  startRunner(
    deadlineAt: number,
    instance: "standard-3",
    egress: { sessionId: string; github: boolean },
    snapshot?: { id: string; image: string },
  ): Promise<unknown>;
};

test("registers the intercepts again when a snapshot is not used after all", async () => {
  // The restored container reports another image: it runs an older Runner.
  const { container, order } = startingContainer("old-image");
  const runner = new RunnerContainer(
    {
      storage: memoryStorage(new Map()),
      container,
      exports: { GitHubEgress: () => ({}), ModelEgress: () => ({}) },
    } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
    {} as ConstructorParameters<typeof RunnerContainer>[1],
  );
  await (runner as unknown as Starting).startRunner(
    Date.now() + 60_000,
    "standard-3",
    { sessionId: "session", github: false },
    { id: "snapshot", image: "image" },
  );
  expect(order).toStrictEqual([
    "intercept chatgpt.com",
    "intercept api.anthropic.com",
    "start snapshot",
    "destroy",
    // A destroyed container loses its intercepts, and with them the CA.
    "intercept chatgpt.com",
    "intercept api.anthropic.com",
    "start image",
  ]);
});

test.for([
  { name: "keeps using", inspected: "image", order: [] },
  {
    name: "replaces",
    inspected: "old-image",
    order: [
      "destroy",
      "intercept chatgpt.com",
      "intercept api.anthropic.com",
      "start image",
    ],
  },
])(
  "$name a waiting container depending on its Runner image",
  async ({ inspected, order: expected }) => {
    const { container, order } = startingContainer(inspected, true);
    class WaitingRunner extends RunnerContainer {
      protected override idleMs = 60_000;
    }
    const runner = new WaitingRunner(
      {
        storage: memoryStorage(new Map([["idleUntil", Date.now() + 60_000]])),
        container,
        exports: { GitHubEgress: () => ({}), ModelEgress: () => ({}) },
      } as unknown as ConstructorParameters<typeof RunnerContainer>[0],
      {} as ConstructorParameters<typeof RunnerContainer>[1],
    );
    await (runner as unknown as Starting).startRunner(
      Date.now() + 60_000,
      "standard-3",
      { sessionId: "session", github: false },
    );
    expect(order).toStrictEqual(expected);
  },
);

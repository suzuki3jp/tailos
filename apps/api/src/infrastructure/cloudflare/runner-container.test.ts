import { expect, test, vi } from "vitest";

import {
  createTestBindings,
  createTestDb,
} from "@/infrastructure/d1/testing.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { hashRunLease, newRunLease } from "@/infrastructure/auth/run-lease.ts";
import { GitHubApp, WorkBranchMoved } from "@/infrastructure/github/app.ts";
import { sessionBranch } from "@tailos/core/runner";
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
    await runner.publishWork(runId, bearer, {
      branch: sessionBranch(crypto.randomUUID()),
      parentSha: "a".repeat(40),
      tree: "b".repeat(40),
      headline: "feat: publish",
      changes: { additions: [], deletions: [] },
    }),
  ).toEqual({ error: "invalid_lease" });
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

async function publishingRun(t: import("vitest").TestContext) {
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
    idempotencyKey: "publishing",
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
  const baseSha = "a".repeat(40);
  const branch = sessionBranch(sessionId);
  await DB.prepare(
    "UPDATE runs SET status = 'running', step_state = ? WHERE id = ?",
  )
    .bind(JSON.stringify({ version: 2, baseSha, branch }), runId)
    .run();
  const bearer = newRunLease();
  const stored = new Map<string, unknown>([
    ["runId", runId],
    ["sessionId", sessionId],
    [
      "refreshLease",
      {
        digest: await hashRunLease(bearer),
        runId,
        expiresAt: Date.now() + 60_000,
      },
    ],
  ]);
  const destroy = vi.fn(async () => {});
  const runner = new RunnerContainer(
    {
      storage: memoryStorage(stored),
      container: {
        running: true,
        destroy,
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
  const work = {
    branch,
    parentSha: baseSha,
    tree: "b".repeat(40),
    headline: "feat: add the feature",
    changes: {
      additions: [{ path: "feature.ts", contents: "Cg==" }],
      deletions: [],
    },
  };
  return { DB, runId, runner, bearer, stored, work, repository, trigger };
}

test("publishes the Agent's work on the Session's branch, once per checked work", async (t) => {
  const { runner, runId, bearer, stored, work, repository, trigger } =
    await publishingRun(t);
  const url = "https://github.com/owner/private/pull/1";
  const first = "c".repeat(40);
  const second = "d".repeat(40);
  let pull: Awaited<ReturnType<GitHubApp["sessionPullRequest"]>> = {
    state: "none",
  };
  vi.spyOn(GitHubApp.prototype, "sessionPullRequest").mockImplementation(
    async () => pull,
  );
  const commit = vi
    .spyOn(GitHubApp.prototype, "commitSessionWork")
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const open = vi
    .spyOn(GitHubApp.prototype, "openPullRequest")
    .mockImplementation(async () => {
      pull = { state: "open", url };
      return url;
    });

  const startsOn = vi
    .spyOn(GitHubApp.prototype, "startsOn")
    .mockResolvedValue(false);
  // Only this Turn, on this Session's branch, may publish, and only from a
  // start on the base branch.
  expect(await runner.publishWork(runId, newRunLease(), work)).toEqual({
    error: "invalid_lease",
  });
  expect(
    await runner.publishWork(runId, bearer, {
      ...work,
      branch: "tailos/session/x",
    }),
  ).toEqual({ error: "invalid_publication" });
  expect(
    await runner.publishWork(runId, bearer, {
      ...work,
      parentSha: "e".repeat(40),
    }),
  ).toEqual({ error: "invalid_base" });
  expect(startsOn).toHaveBeenCalledExactlyOnceWith(
    repository,
    repository.defaultBranch,
    "e".repeat(40),
  );
  expect(commit).not.toHaveBeenCalled();

  expect(await runner.publishWork(runId, bearer, work)).toEqual({
    sha: first,
    url,
  });
  expect(open).toHaveBeenCalledExactlyOnceWith(repository, trigger, runId, {
    branch: work.branch,
    sha: first,
    headline: work.headline,
  });
  // The same work again, after its response was lost, is not committed twice.
  expect(await runner.publishWork(runId, bearer, work)).toEqual({
    sha: first,
    url,
  });
  expect(commit).toHaveBeenCalledOnce();
  // Changed work on the old parent, after the answer was lost, is told where
  // the branch went instead.
  expect(
    await runner.publishWork(runId, bearer, { ...work, tree: "9".repeat(40) }),
  ).toEqual({ error: "parent_moved", sha: first });
  expect(commit).toHaveBeenCalledOnce();

  // The next publication builds on the last one and updates the open PR.
  const next = { ...work, parentSha: first, tree: "f".repeat(40) };
  expect(await runner.publishWork(runId, bearer, next)).toEqual({
    sha: second,
    url,
  });
  expect(commit).toHaveBeenLastCalledWith(
    repository,
    runId,
    next,
    expect.any(Number),
  );
  expect(open).toHaveBeenCalledOnce();
  expect(stored.get("sessionPublication")).toEqual({
    branch: work.branch,
    sha: second,
    parentSha: first,
    tree: next.tree,
    url,
  });

  // A merged pull request is not published to again; neither is a branch
  // that someone else moved.
  pull = { state: "merged" };
  const later = { ...work, parentSha: second, tree: "9".repeat(40) };
  expect(await runner.publishWork(runId, bearer, later)).toEqual({
    error: "pull_request_merged",
  });
  pull = { state: "open", url };
  commit.mockRejectedValueOnce(new WorkBranchMoved("moved"));
  expect(await runner.publishWork(runId, bearer, later)).toEqual({
    error: "branch_moved",
  });
  expect(stored.get("sessionPublication")).toMatchObject({ sha: second });
});

test("publishes into the branch the Agent started from, and keeps that base", async (t) => {
  const { runner, runId, bearer, stored, work, repository, trigger } =
    await publishingRun(t);
  const url = "https://github.com/owner/private/pull/2";
  const feature = "e".repeat(40);
  const first = "c".repeat(40);
  const pulls = vi
    .spyOn(GitHubApp.prototype, "sessionPullRequest")
    .mockResolvedValue({ state: "none" });
  const startsOn = vi
    .spyOn(GitHubApp.prototype, "startsOn")
    .mockImplementation(
      async (_target, base, sha) => base === "feature" && sha === feature,
    );
  vi.spyOn(GitHubApp.prototype, "commitSessionWork").mockResolvedValue(first);
  const open = vi
    .spyOn(GitHubApp.prototype, "openPullRequest")
    .mockResolvedValue(url);
  const moved = { ...work, base: "feature", parentSha: feature };

  // The base cannot be the Session's own branch, and must hold the start.
  expect(
    await runner.publishWork(runId, bearer, { ...moved, base: work.branch }),
  ).toEqual({ error: "invalid_base" });
  expect(
    await runner.publishWork(runId, bearer, { ...moved, base: "other" }),
  ).toEqual({ error: "invalid_base" });
  expect(await runner.publishWork(runId, bearer, moved)).toEqual({
    sha: first,
    url,
  });
  expect(startsOn).toHaveBeenLastCalledWith(repository, "feature", feature);
  expect(pulls).toHaveBeenCalledWith(repository, work.branch, "feature");
  expect(open).toHaveBeenCalledExactlyOnceWith(repository, trigger, runId, {
    branch: work.branch,
    sha: first,
    headline: work.headline,
    base: "feature",
  });
  expect(stored.get("sessionPublication")).toMatchObject({
    branch: work.branch,
    base: "feature",
    sha: first,
  });
  // The pull request keeps its base: another one is refused, and later
  // publications without one stay on it.
  const next = { ...work, parentSha: first, tree: "f".repeat(40) };
  expect(
    await runner.publishWork(runId, bearer, { ...next, base: "main" }),
  ).toEqual({ error: "invalid_base" });
  pulls.mockResolvedValue({ state: "open", url });
  expect(await runner.publishWork(runId, bearer, next)).toEqual({
    sha: first,
    url,
  });
  expect(pulls).toHaveBeenLastCalledWith(repository, work.branch, "feature");
});

test("a Turn's result is the pull request it published, and the Session keeps its branch", async (t) => {
  const { DB, runner, runId, bearer, stored, work } = await publishingRun(t);
  const url = "https://github.com/owner/private/pull/1";
  const sha = "c".repeat(40);
  vi.spyOn(GitHubApp.prototype, "sessionPullRequest").mockResolvedValue({
    state: "none",
  });
  vi.spyOn(GitHubApp.prototype, "commitSessionWork").mockResolvedValue(sha);
  vi.spyOn(GitHubApp.prototype, "openPullRequest").mockResolvedValue(url);
  // A branch the Session moved to after a merge has nothing published yet.
  stored.set("sessionPublication", {
    branch: work.branch,
    realignFrom: "e".repeat(40),
  });
  expect(await runner.publishWork(runId, bearer, work)).toEqual({ sha, url });

  await runner.alarm();
  const run = await DB.prepare("SELECT status, result FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ status: string; result: string }>();
  expect(run?.status).toBe("succeeded");
  expect(JSON.parse(run!.result)).toMatchObject({
    kind: "pull_request",
    branch: work.branch,
    sha,
    url,
  });
  // The next Turn publishes on the same branch, but has no result of its own yet.
  expect(stored.has("runPublication")).toBe(false);
  expect(stored.get("sessionPublication")).toStrictEqual({
    branch: work.branch,
    sha,
    parentSha: work.parentSha,
    tree: work.tree,
    url,
  });
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
      branch: `tailos/issue-3/${runId}`,
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
    merged: false,
  },
  {
    name: "the image after an update",
    snapshotImage: "old-image",
    fromSnapshot: false,
    merged: false,
  },
  {
    name: "moves it onto the default branch after its PR was merged",
    snapshotImage: "image",
    fromSnapshot: true,
    merged: true,
  },
])(
  "continues a Session's Turn from its saved work and $name, and keeps the new work",
  async ({ snapshotImage, fromSnapshot, merged }, t) => {
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
      // What an earlier Turn published, which this one builds on.
      [
        "sessionPublication",
        {
          branch: sessionBranch(sessionId),
          sha: "e".repeat(40),
          parentSha: savedBase,
          tree: "f".repeat(40),
          url: "https://github.com/owner/repo/pull/1",
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
        if (merged) {
          // The saved work moves from its own base onto the latest branch,
          // and the Session publishes to its next branch.
          expect(job.checkout).toStrictEqual({
            repository: "owner/repo",
            baseSha: "a".repeat(40),
            branch: sessionBranch(sessionId, 2),
            realign: { previousBase: savedBase, publishedSha: "e".repeat(40) },
          });
        } else {
          // The saved work continues on its own base, not the latest branch.
          expect(job.checkout.baseSha).toBe(savedBase);
          expect(job.checkout).toMatchObject({
            branch: sessionBranch(sessionId),
            publishedSha: "e".repeat(40),
          });
        }
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
        branch: merged ? sessionBranch(sessionId, 2) : sessionBranch(sessionId),
      });
    vi.spyOn(GitHubApp.prototype, "sessionPullRequest").mockResolvedValue(
      merged
        ? { state: "merged" }
        : { state: "open", url: "https://github.com/owner/repo/pull/1" },
    );
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
    // The Session publishes to its own branch.
    expect(checkout.mock.calls[0]![2]).toBe(
      sessionBranch(sessionId, merged ? 2 : 1),
    );
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
      baseSha: merged ? "a".repeat(40) : savedBase,
      snapshot: { id: "snapshot-1", image: "image" },
    });
    // Only the latest work of the Session is kept.
    expect(objects.has(previousKey)).toBe(false);
    expect(memory.has("continuityRun")).toBe(false);
    // Once the work moved, later Turns build on the new branch as it is.
    if (merged)
      expect(memory.get("sessionPublication")).toStrictEqual({
        branch: sessionBranch(sessionId, 2),
      });
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
    egress: { sessionId: string; github: boolean; codex: boolean },
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
    { sessionId: "session", github: false, codex: true },
    { id: "snapshot", image: "image" },
  );
  expect(order).toStrictEqual([
    "intercept chatgpt.com",
    "start snapshot",
    "destroy",
    // A destroyed container loses its intercepts, and with them the CA.
    "intercept chatgpt.com",
    "start image",
  ]);
});

test.for([
  { name: "keeps using", inspected: "image", order: [] },
  {
    name: "replaces",
    inspected: "old-image",
    order: ["destroy", "intercept chatgpt.com", "start image"],
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
      { sessionId: "session", github: false, codex: true },
    );
    expect(order).toStrictEqual(expected);
  },
);

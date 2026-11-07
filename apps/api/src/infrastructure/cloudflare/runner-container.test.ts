import { expect, test, vi } from "vitest";

import { createTestDb } from "../d1/testing.ts";
import { admitTrigger } from "../d1/trigger-admission.ts";
import { hashRunLease, newRunLease } from "../auth/run-lease.ts";
import { GitHubApp } from "../github/app.ts";
import { RunnerContainer } from "./runner-container.ts";

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
  const branch = `meguri/issue-1/${runId}`;
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
  state: "failed" | "lost",
) {
  const DB = await createTestDb(t);
  const target = {
    repository: "owner/private",
    repositoryId: 42,
    installationId: 19,
    issueNumber: 8,
    defaultBranch: "main",
    triggerLabel: "meguri:run",
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
    branch: `meguri/issue-8/${runId}`,
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
      MEGURI_GH_APP_ID: "100",
      MEGURI_GH_APP_PRIVATE_KEY: "unused-test-key",
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

import { expect, test, vi } from "vitest";

import { createTestDb } from "../d1/testing.ts";
import { admitTrigger } from "../d1/trigger-admission.ts";
import { hashRunLease, newRunLease } from "../auth/run-lease.ts";
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

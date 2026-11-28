import { expect, test, vi } from "vitest";
import { createTestBindings } from "@/infrastructure/d1/testing.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { runStarter } from "@/infrastructure/cloudflare/run-start.ts";

test("schedules a Run on the Runner of its Session", async (t) => {
  const { DB } = await createTestBindings(t);
  const { runId, sessionId } = await admitTrigger(DB, {
    source: "test",
    idempotencyKey: "run",
    ownerId: "owner",
    concurrencyKey: "target",
    prompt: "test",
    executionContext: '{"version":1,"engine":"fake"}',
    timeoutMs: 60_000,
  });
  const schedule = vi.fn(async (_runId: string, _sessionId: string) => {});
  const getByName = vi.fn((_name: string) => ({ schedule }));
  const start = runStarter({ DB, RUNNER: { getByName } as never });

  await start!(runId);
  expect(getByName).toHaveBeenCalledExactlyOnceWith(sessionId);
  expect(schedule).toHaveBeenCalledExactlyOnceWith(runId, sessionId);
  await expect(start!(crypto.randomUUID())).rejects.toThrow(/no Session/);
  expect(runStarter({ DB })).toBeUndefined();
});

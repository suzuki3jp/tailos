import { expect, test } from "vitest";
import { runActivityLabel } from "./activity";

test("uses the recorded agent runtime and falls back when an older run has no timing", () => {
  const run = {
    id: "run",
    status: "succeeded" as const,
    startMessageId: "prompt",
    engine: "codex",
    agentDurationMs: 752_900,
    result: null,
    errorCode: null,
  };
  expect(runActivityLabel(run)).toBe("Worked for 12m 32s");
  expect(runActivityLabel({ ...run, agentDurationMs: null })).toBe("Completed");
  expect(runActivityLabel({ ...run, status: "running" })).toBe("Working…");
});

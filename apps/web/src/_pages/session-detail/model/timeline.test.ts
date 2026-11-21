import { expect, test } from "vitest";
import type { TimelineItem } from "@tailos/core/timeline";
import { mergeTimeline, timelineOutput } from "./timeline";

const item: TimelineItem = {
  id: "item",
  runId: "run",
  kind: "command",
  label: "pnpm test",
  text: null,
  status: "running",
  startedAt: 1,
  finishedAt: null,
  durationMs: null,
  exitCode: null,
  revision: 1,
  bodyExpiresAt: 9999999999999,
  hasInput: true,
  hasOutput: false,
};
test("late/replayed starts never undo a completed item or duplicate it", () => {
  const completed = {
    ...item,
    status: "succeeded" as const,
    revision: 2,
    finishedAt: 2,
  };
  expect(mergeTimeline([completed], [item, completed])).toEqual([completed]);
  expect(mergeTimeline([item], [completed])[0].status).toBe("succeeded");
  expect(timelineOutput('{"output":"42 passed"}')).toBe("42 passed");
  expect(timelineOutput("plain output")).toBe("plain output");
});

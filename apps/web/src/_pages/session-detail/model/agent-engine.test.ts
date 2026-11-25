import { expect, test } from "vitest";
import { runEngine, sessionEngine } from "./agent-engine";

test("a Session keeps the Model Provider of its latest Run", () => {
  expect(sessionEngine([{ engine: "codex" }, { engine: "claude" }])).toBe(
    "claude",
  );
  expect(sessionEngine([])).toBeUndefined();
  expect(runEngine("fake")).toBeUndefined();
  expect(runEngine(null)).toBeUndefined();
});

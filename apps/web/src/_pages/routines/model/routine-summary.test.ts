import { expect, test } from "vitest";
import { modelLabel, triggerCondition, triggerEvent } from "./routine-summary";

test("shows the model and effort, naming the provider when it picks the model", () => {
  expect(
    modelLabel({ engine: "codex", model: "gpt-6.1-sol", effort: "high" }),
  ).toBe("gpt-6.1-sol / high");
  expect(modelLabel({ engine: "claude" })).toBe("Claude default / default");
});

test("describes each trigger by its GitHub event and condition", () => {
  const label = {
    version: 1,
    type: "github.issue-label",
    label: "tailos:run",
  } as const;
  const comment = {
    version: 1,
    type: "github.issue-comment",
    command: "plan",
  } as const;
  expect([triggerEvent(label), triggerCondition(label)]).toEqual([
    "labeled",
    "tailos:run",
  ]);
  expect([triggerEvent(comment), triggerCondition(comment)]).toEqual([
    "commented",
    "@tailos plan",
  ]);
});

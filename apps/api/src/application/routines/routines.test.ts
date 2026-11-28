import { expect, test } from "vitest";
import {
  currentInstructions,
  implementationPrompt,
  legacyImplementationPrompt,
  legacyPlanningPrompt,
  planningPrompt,
} from "./routines.ts";

test("a Turn carrying an old default prompt gets the current one", () => {
  expect(currentInstructions(legacyImplementationPrompt)).toBe(
    implementationPrompt,
  );
  // Planning once had its instructions added by the Runner's read-only mode.
  expect(currentInstructions(legacyPlanningPrompt)).toBe(planningPrompt);
  expect(currentInstructions("Plan it my way.")).toBe("Plan it my way.");
  expect(currentInstructions(undefined)).toBeUndefined();
});

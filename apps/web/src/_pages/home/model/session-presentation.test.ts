import { expect, test } from "vitest";
import { updatedLabel } from "./session-presentation";

test("formats API millisecond timestamps as minutes, hours and days without negative elapsed times", () => {
  const now = Date.UTC(2026, 10, 17);
  expect(updatedLabel(now, now)).toBe("Updated just now");
  expect(updatedLabel(now + 60_000, now)).toBe("Updated just now");
  expect(updatedLabel(now - 3 * 60_000, now)).toBe("Updated 3 minutes ago");
  expect(updatedLabel(now - 4 * 3_600_000, now)).toBe("Updated 4 hours ago");
  expect(updatedLabel(now - 3 * 86_400_000, now)).toBe("Updated 3 days ago");
});

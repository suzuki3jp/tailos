import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { RunnerContainer } from "./runner-container.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState) {}
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

  assert.equal(await runner.checkHealth(), true);
  assert.equal(warn.mock.calls.length, 1);
});

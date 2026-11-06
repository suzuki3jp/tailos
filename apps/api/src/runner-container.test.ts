import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx) { this.ctx = ctx } }",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { RunnerContainer } = await import("./runner-container.ts").finally(() =>
  hooks.deregister(),
);

test("a failed container cleanup preserves the runner health result", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
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
  assert.equal(warn.mock.callCount(), 1);
});

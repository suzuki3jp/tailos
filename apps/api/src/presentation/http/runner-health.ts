import { Hono } from "hono";
import type { Bindings } from "../../bindings.ts";
import { smokeAuth } from "./smoke-auth.ts";

export const runnerHealth = new Hono<{ Bindings: Bindings }>();
runnerHealth.post("/health", smokeAuth, async (c) => {
  const runner = c.env.RUNNER;
  if (!runner) return c.json({ error: "runner_unavailable" }, 503);

  try {
    if (await runner.get(runner.newUniqueId()).checkHealth()) {
      return c.json({ status: "ok", service: "runner" });
    }
  } catch {
    return c.json({ error: "runner_unavailable" }, 503);
  }
  return c.json({ error: "runner_unavailable" }, 503);
});

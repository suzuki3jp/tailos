import { Hono } from "hono";
import type { Bindings } from "../../../../bindings.ts";
import { smokeAuth } from "../../middlewares/smoke-auth.ts";

export function createRunnerHealthRoutes(
  check: (env: Bindings) => Promise<boolean> | undefined,
) {
  const runnerHealth = new Hono<{ Bindings: Bindings }>();
  runnerHealth.post("/health", smokeAuth, async (c) => {
    try {
      if (await check(c.env)) {
        return c.json({ status: "ok", service: "runner" });
      }
    } catch {
      return c.json({ error: "runner_unavailable" }, 503);
    }
    return c.json({ error: "runner_unavailable" }, 503);
  });

  return runnerHealth;
}

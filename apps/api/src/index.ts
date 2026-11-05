import { Hono } from "hono";
import { smokeAuth, type Bindings } from "./internal.ts";
import { sessionRoutes } from "./sessions.ts";
import { triggerRoutes } from "./triggers.ts";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/_internal/sessions", sessionRoutes);
app.route("/_internal/triggers", triggerRoutes);

app.post("/_internal/runner/health", smokeAuth, async (c) => {
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

export default app;

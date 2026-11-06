import { findOwnedRun } from "../infrastructure/d1/owned-runs.ts";
import { runnerHealth } from "../presentation/http/runner-health.ts";
import { admitTrigger } from "../infrastructure/d1/trigger-admission.ts";
import { Hono } from "hono";
import { type Bindings } from "../bindings.ts";
import { createRunRoutes } from "../presentation/http/runs.ts";
import { createSessionRoutes } from "../presentation/http/sessions.ts";
import { d1Sessions } from "../infrastructure/d1/sessions.ts";
import { createTriggerRoutes } from "../presentation/http/triggers.ts";

const { sessionRoutes } = createSessionRoutes((env) => d1Sessions(env.DB));

const triggerRoutes = createTriggerRoutes(
  (env) => (input) => admitTrigger(env.DB, input),
);

const runRoutes = createRunRoutes((env, id, ownerId) =>
  findOwnedRun(env.DB, id, ownerId),
);

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/_internal/runs", runRoutes);
app.route("/_internal/sessions", sessionRoutes);
app.route("/_internal/triggers", triggerRoutes);

app.route("/_internal/runner", runnerHealth);

export default app;

import { admitTrigger } from "../infrastructure/d1/trigger-admission.ts";
import { Hono } from "hono";
import type { Bindings } from "../bindings.ts";
import { createSessionRoutes } from "../presentation/http/sessions.ts";
import { d1Sessions } from "../infrastructure/d1/sessions.ts";
import { createTriggerRoutes } from "../presentation/http/triggers.ts";

const { sessionRoutes } = createSessionRoutes((env) => d1Sessions(env.DB));

const triggerRoutes = createTriggerRoutes(
  (env) => (input) => admitTrigger(env.DB, input),
);

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/_internal/sessions", sessionRoutes);
app.route("/_internal/triggers", triggerRoutes);

export default app;

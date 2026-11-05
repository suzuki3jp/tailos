import { Hono } from "hono";
import type { Bindings } from "./internal.ts";
import { sessionRoutes } from "./sessions.ts";
import { triggerRoutes } from "./triggers.ts";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/_internal/sessions", sessionRoutes);
app.route("/_internal/triggers", triggerRoutes);

export default app;

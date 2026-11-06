import type { Bindings } from "../bindings.ts";
import { Hono } from "hono";
import { createSessionRoutes } from "../presentation/http/sessions.ts";
import { d1Sessions } from "../infrastructure/d1/sessions.ts";

const { sessionRoutes } = createSessionRoutes((env) => d1Sessions(env.DB));

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/_internal/sessions", sessionRoutes);

export default app;

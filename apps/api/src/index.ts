import { Hono } from "hono";
import { sessionRoutes, type Bindings } from "./sessions.ts";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/_internal/sessions", sessionRoutes);

export default app;

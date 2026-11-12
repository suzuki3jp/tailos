import { Hono } from "hono";
import type { McpAuthentication } from "@/application/auth/mcp-key.ts";
import type { InspectionStore } from "@/application/inspection/inspection.ts";
import type { Bindings } from "@/bindings.ts";
import { inspectionMcp } from "@/presentation/mcp/server.ts";

export function createMcpRoutes(
  authenticate: (env: Bindings, headers: Headers) => Promise<McpAuthentication>,
  store: (env: Bindings) => InspectionStore,
) {
  return new Hono<{ Bindings: Bindings }>().all("/", async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const publicOrigin = c.env?.TAILOS_PUBLIC_ORIGIN;
    if (!publicOrigin || new URL(c.req.url).origin !== publicOrigin)
      return c.json({ error: "not_found" }, 404);
    const origin = c.req.header("Origin");
    if (origin && origin !== publicOrigin && origin !== c.env.TAILOS_WEB_ORIGIN)
      return c.json({ error: "forbidden" }, 403);
    const auth = await authenticate(c.env, c.req.raw.headers);
    if (auth.state === "disabled") return c.json({ error: "not_found" }, 404);
    if (auth.state === "unauthorized") {
      c.header("WWW-Authenticate", 'Bearer realm="tailos-read"');
      return c.json({ error: "unauthorized" }, 401);
    }
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json({ error: "method_not_allowed" }, 405);
    }
    // One protocol server per request: auth and tool closures cannot leak
    // between concurrent callers. The SDK owns JSON-RPC and era compatibility.
    const response = await inspectionMcp(store(c.env), auth.ownerId).fetch(
      c.req.raw,
    );
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  });
}

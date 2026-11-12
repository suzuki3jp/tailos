import { createMiddleware } from "hono/factory";

declare module "hono" {
  interface ContextVariableMap {
    diagnosticRequest: { traceId: string; requestId: string };
  }
}

export const requestDiagnostics = createMiddleware(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("diagnosticRequest", { requestId, traceId: `request/${requestId}` });
  c.header("X-Request-ID", requestId);
  await next();
  if (c.res.status >= 400) {
    // oxlint-disable-next-line no-console -- No headers, query strings, or response bodies.
    console.info({
      event: "http_request_finished",
      requestId,
      traceId: `request/${requestId}`,
      status: c.res.status,
    });
  }
});

import handler from "vinext/server/fetch-handler";
import { apiOrigin, isPreview } from "@/shared/config";

export default {
  async fetch(request: Request, env, ctx) {
    if (isPreview) {
      const url = new URL(request.url);
      if (url.origin !== apiOrigin) return new Response(null, { status: 404 });
      if (url.pathname.startsWith("/v1/")) {
        const secret = env.TAILOS_PREVIEW_PROXY_SECRET;
        const origin = env.TAILOS_PREVIEW_API_ORIGIN;
        if (!secret || !origin) return new Response(null, { status: 503 });
        const upstream = new URL(origin);
        upstream.pathname = url.pathname;
        upstream.search = url.search;
        const headers = new Headers(request.headers);
        headers.delete("Host");
        headers.set("X-Tailos-Preview-Proxy", secret);
        return fetch(new Request(upstream, request), {
          headers,
          redirect: "manual",
        });
      }
    }
    const nonce = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    );
    const nonceSource = `'nonce-${nonce}'`;
    const scriptSource = import.meta.env.DEV
      ? "'unsafe-inline' 'unsafe-eval'"
      : nonceSource;
    const styleSource = import.meta.env.DEV ? "'unsafe-inline'" : nonceSource;
    const csp = [
      "default-src 'none'",
      `script-src 'self' ${scriptSource}`,
      `style-src 'self' ${styleSource}`,
      "style-src-attr 'unsafe-inline'",
      "img-src 'self'",
      "font-src 'self'",
      `connect-src 'self' ${apiOrigin} ${apiOrigin.replace(/^http/, "ws")}${import.meta.env.DEV ? " ws: wss:" : ""}`,
      `form-action 'self' ${apiOrigin} https://github.com`,
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; ");

    // vinext reads the request CSP to tag its streamed inline scripts.
    const securedRequest = new Request(request);
    securedRequest.headers.set("Content-Security-Policy", csp);
    const response: Response = await handler.fetch(securedRequest, env, ctx);
    if (!response.headers.get("Content-Type")?.startsWith("text/html")) {
      return response;
    }

    const securedResponse = new Response(response.body, response);
    securedResponse.headers.set("Content-Security-Policy", csp);
    securedResponse.headers.set("Cache-Control", "private, no-store");
    // Cross-origin login forms must retain the Origin header for the API check.
    securedResponse.headers.set("Referrer-Policy", "strict-origin");
    securedResponse.headers.set("X-Frame-Options", "DENY");
    securedResponse.headers.set("X-Content-Type-Options", "nosniff");
    return securedResponse;
  },
} satisfies ExportedHandler<{
  ASSETS: Fetcher;
  TAILOS_PREVIEW_API_ORIGIN?: string;
  TAILOS_PREVIEW_PROXY_SECRET?: string;
}>;

import handler from "vinext/server/fetch-handler";
import { apiOrigin } from "../api-origin.ts";

export default {
  async fetch(request: Request, env, ctx) {
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
      "img-src 'self'",
      "font-src 'self'",
      `connect-src 'self' ${apiOrigin}${import.meta.env.DEV ? " ws: wss:" : ""}`,
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
} satisfies ExportedHandler<{ ASSETS: Fetcher }>;

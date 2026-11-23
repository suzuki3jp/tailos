import { loginSessionCookieName, webBrowserApiPath } from "@tailos/core/auth";
import handler from "vinext/server/fetch-handler";
import { apiOrigin, isPreview, usesWebApiProxy } from "@/shared/config";
import {
  fetchBrowserApi,
  type BrowserApiBindings,
} from "@/shared/config/index.server";

const legacyCookieName = `__Secure-${loginSessionCookieName}`;

export default {
  async fetch(request: Request, env, ctx) {
    const { origin, pathname, hostname } = new URL(request.url);
    const isApiRequest =
      usesWebApiProxy &&
      (pathname === webBrowserApiPath ||
        pathname.startsWith(`${webBrowserApiPath}/`));
    if ((isPreview || isApiRequest) && origin !== apiOrigin)
      return new Response(null, { status: 404 });
    if (isApiRequest) return fetchBrowserApi(env, request);

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
    if (
      !isPreview &&
      usesWebApiProxy &&
      origin === apiOrigin &&
      request.headers
        .get("Cookie")
        ?.split(";")
        .some((cookie) => cookie.trimStart().startsWith(`${legacyCookieName}=`))
    ) {
      securedResponse.headers.append(
        "Set-Cookie",
        `${legacyCookieName}=; Max-Age=0; Path=/; Domain=${hostname}; HttpOnly; Secure; SameSite=Lax`,
      );
    }
    return securedResponse;
  },
} satisfies ExportedHandler<{ ASSETS: Fetcher } & BrowserApiBindings>;

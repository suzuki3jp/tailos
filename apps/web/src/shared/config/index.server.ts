import { isPreview } from "./api-origin";

export type BrowserApiBindings = {
  BROWSER_API?: Fetcher;
  TAILOS_PREVIEW_API_ORIGIN?: string;
  TAILOS_PREVIEW_PROXY_SECRET?: string;
};

export function fetchBrowserApi(
  env: BrowserApiBindings,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const options = { ...init, redirect: "manual" } satisfies RequestInit;
  if (!isPreview) {
    return (
      env.BROWSER_API?.fetch(input, options) ??
      new Response(null, { status: 503 })
    );
  }

  const upstream = URL.parse(env.TAILOS_PREVIEW_API_ORIGIN ?? "");
  const secret = env.TAILOS_PREVIEW_PROXY_SECRET;
  if (upstream?.protocol !== "https:" || !secret)
    return new Response(null, { status: 503 });
  const request = new Request(input, options);
  const { pathname, search } = new URL(request.url);
  upstream.pathname = pathname;
  upstream.search = search;
  const forwarded = new Request(upstream, request);
  forwarded.headers.delete("Host");
  forwarded.headers.set("X-Tailos-Preview-Proxy", secret);
  return fetch(forwarded);
}

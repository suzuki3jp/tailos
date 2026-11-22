import {
  loginSessionCookieName,
  webLoginSessionCookieName,
} from "@tailos/core/auth";
import { apiOrigin, usesWebApiProxy } from "../config";
import { createApiClient } from "./client";

export function createServerApi(cookieHeader: string, signal?: AbortSignal) {
  const name = usesWebApiProxy
    ? webLoginSessionCookieName
    : `${apiOrigin.startsWith("https:") ? "__Secure-" : ""}${loginSessionCookieName}`;
  const sessionCookie = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  return createApiClient(async (input, init) => {
    const headers = new Headers(init?.headers);
    if (sessionCookie) headers.set("Cookie", sessionCookie);
    const options = {
      ...init,
      signal:
        signal && init?.signal
          ? AbortSignal.any([signal, init.signal])
          : (signal ?? init?.signal),
      headers,
      cache: "no-store",
      redirect: "manual",
    } satisfies RequestInit;
    if (!usesWebApiProxy) return fetch(input, options);

    const { env } = await import("cloudflare:workers");
    const binding = (env as { BROWSER_API?: Fetcher }).BROWSER_API;
    return binding
      ? binding.fetch(input, options)
      : new Response(null, { status: 503 });
  });
}

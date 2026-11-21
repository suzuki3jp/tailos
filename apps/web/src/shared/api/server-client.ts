import { loginSessionCookieName } from "@tailos/core/auth";
import { apiOrigin, isPreview } from "../config";
import { createApiClient } from "./client";

export function createServerApi(cookieHeader: string, signal?: AbortSignal) {
  const name = `${apiOrigin.startsWith("https:") ? "__Secure-" : ""}${loginSessionCookieName}`;
  const sessionCookie = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  return createApiClient(async (input, init) => {
    const headers = new Headers(init?.headers);
    if (sessionCookie) headers.set("Cookie", sessionCookie);
    let target = input;
    if (isPreview) {
      const { env } = await import("cloudflare:workers");
      const {
        TAILOS_PREVIEW_API_ORIGIN: origin,
        TAILOS_PREVIEW_PROXY_SECRET: secret,
      } = env as {
        TAILOS_PREVIEW_API_ORIGIN?: string;
        TAILOS_PREVIEW_PROXY_SECRET?: string;
      };
      if (!origin || !secret)
        throw new Error("Missing Preview API proxy configuration");
      const url = new URL(String(input));
      const upstream = new URL(origin);
      upstream.pathname = url.pathname;
      upstream.search = url.search;
      target = upstream.href;
      headers.set("X-Tailos-Preview-Proxy", secret);
    }
    return fetch(target, {
      ...init,
      signal:
        signal && init?.signal
          ? AbortSignal.any([signal, init.signal])
          : (signal ?? init?.signal),
      headers,
      cache: "no-store",
      redirect: "manual",
    });
  });
}

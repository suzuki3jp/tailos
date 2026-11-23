import {
  loginSessionCookieName,
  previewLoginSessionCookieName,
  webLoginSessionCookieName,
} from "@tailos/core/auth";
import { apiOrigin, isPreview, usesWebApiProxy } from "../config";
import {
  fetchBrowserApi,
  type BrowserApiBindings,
} from "../config/index.server";
import { createApiClient } from "./client";

function sessionCookieName() {
  if (isPreview) return previewLoginSessionCookieName;
  if (usesWebApiProxy) return webLoginSessionCookieName;
  return `${apiOrigin.startsWith("https:") ? "__Secure-" : ""}${loginSessionCookieName}`;
}

export function createServerApi(cookieHeader: string, signal?: AbortSignal) {
  const name = sessionCookieName();
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
    return fetchBrowserApi(env as BrowserApiBindings, input, options);
  });
}

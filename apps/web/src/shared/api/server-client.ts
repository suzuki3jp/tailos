import { loginSessionCookieName } from "@tailos/core/auth";
import { apiOrigin } from "../config";
import { createApiClient } from "./client";

export function createServerApi(cookieHeader: string, signal?: AbortSignal) {
  const name = `${apiOrigin.startsWith("https:") ? "__Secure-" : ""}${loginSessionCookieName}`;
  const sessionCookie = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  return createApiClient((input, init) => {
    const headers = new Headers(init?.headers);
    if (sessionCookie) headers.set("Cookie", sessionCookie);
    return fetch(input, {
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

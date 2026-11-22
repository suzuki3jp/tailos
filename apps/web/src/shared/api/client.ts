import type { BrowserApi } from "@tailos/api/browser";
import { hc } from "hono/client";
import { browserApiBaseUrl } from "../config";

export function createApiClient(
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return hc<BrowserApi>(browserApiBaseUrl, { fetch: request });
}

export const api = createApiClient((input, init) =>
  fetch(input, { ...init, credentials: "include" }),
);

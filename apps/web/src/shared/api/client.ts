import type { BrowserApi } from "@tailos/api/browser";
import { hc } from "hono/client";
import { apiOrigin } from "../config";

export function createApiClient(
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return hc<BrowserApi>(new URL("/v1", apiOrigin).href, { fetch: request });
}

export const api = createApiClient((input, init) =>
  fetch(input, { ...init, credentials: "include" }),
);

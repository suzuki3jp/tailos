import type { BrowserApi } from "@tailos/api/browser";
import { hc } from "hono/client";
import { apiOrigin } from "../config";

export const api = hc<BrowserApi>(new URL("/v1", apiOrigin).href, {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, credentials: "include" }),
});

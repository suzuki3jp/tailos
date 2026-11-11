import type { BrowserApi } from "@tailos/api/browser";
import { hc } from "hono/client";
import { apiOrigin } from "@/api-origin.ts";

export const api = hc<BrowserApi>(new URL("/api", apiOrigin).href, {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, credentials: "include" }),
});

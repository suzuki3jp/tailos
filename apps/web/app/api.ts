import type { BrowserApi } from "@meguri/api/browser";
import { hc } from "hono/client";

export const apiOrigin =
  import.meta.env.VITE_API_ORIGIN ??
  (import.meta.env.DEV
    ? "http://localhost:8787"
    : "https://api.meguri.suzuki3.jp");

export const api = hc<BrowserApi>(new URL("/api", apiOrigin).href, {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, credentials: "include" }),
});

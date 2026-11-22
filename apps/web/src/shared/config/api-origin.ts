import { directBrowserApiPath, webBrowserApiPath } from "@tailos/core/auth";

export const usesWebApiProxy =
  !import.meta.env.DEV && !import.meta.env.VITE_API_ORIGIN;
export const apiOrigin = new URL(
  import.meta.env.VITE_API_ORIGIN ??
    (import.meta.env.DEV ? "http://localhost:8787" : "https://tailos.app"),
).origin;
export const browserApiBaseUrl = new URL(
  usesWebApiProxy ? webBrowserApiPath : directBrowserApiPath,
  apiOrigin,
).href;

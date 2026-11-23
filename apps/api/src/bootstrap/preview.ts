import { timingSafeEqual } from "node:crypto";
import type { Bindings } from "@/bindings.ts";
import app, { browserProxy } from "./http.ts";

type PreviewBindings = Bindings & { TAILOS_PREVIEW_PROXY_SECRET: string };

export default {
  fetch(request: Request, env, ctx) {
    const url = new URL(request.url);
    const secret = env.TAILOS_PREVIEW_PROXY_SECRET;
    const provided = request.headers.get("X-Tailos-Preview-Proxy");
    if (
      env.TAILOS_PREVIEW !== "true" ||
      env.TAILOS_BROWSER_API_VIA_WEB !== "true" ||
      !env.TAILOS_WEB_ORIGIN ||
      !secret ||
      !provided
    ) {
      return new Response(null, { status: 404 });
    }
    const expected = Buffer.from(secret);
    const candidate = Buffer.from(provided);
    if (
      candidate.length !== expected.length ||
      !timingSafeEqual(candidate, expected)
    ) {
      return new Response(null, { status: 404 });
    }

    // Hono and Better Auth validate the public URL, including the OAuth callback.
    const publicUrl = new URL(env.TAILOS_WEB_ORIGIN);
    publicUrl.pathname = url.pathname;
    publicUrl.search = url.search;
    const forwarded = new Request(publicUrl, request);
    forwarded.headers.delete("X-Tailos-Preview-Proxy");
    const router = url.pathname === "/health" ? app : browserProxy;
    return router.fetch(forwarded, env, ctx);
  },
} satisfies ExportedHandler<PreviewBindings>;

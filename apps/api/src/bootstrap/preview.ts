import { timingSafeEqual } from "node:crypto";
import type { Bindings } from "@/bindings.ts";
import app from "./http.ts";

type PreviewBindings = Bindings & { TAILOS_PREVIEW_PROXY_SECRET: string };

export default {
  fetch(request: Request, env, ctx) {
    const url = new URL(request.url);
    const secret = env.TAILOS_PREVIEW_PROXY_SECRET;
    const provided = request.headers.get("X-Tailos-Preview-Proxy");
    if (
      (url.pathname !== "/health" && !url.pathname.startsWith("/v1/")) ||
      !env.TAILOS_PUBLIC_ORIGIN ||
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
    const publicUrl = new URL(env.TAILOS_PUBLIC_ORIGIN);
    publicUrl.pathname = url.pathname;
    publicUrl.search = url.search;
    const forwarded = new Request(publicUrl, request);
    forwarded.headers.delete("X-Tailos-Preview-Proxy");
    return app.fetch(forwarded, env, ctx);
  },
} satisfies ExportedHandler<PreviewBindings>;

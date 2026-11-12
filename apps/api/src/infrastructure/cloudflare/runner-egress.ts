import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "@/bindings.ts";

// Deployment-owned policy. Never derive rules from a job, prompt or PROJECTS.
export function runnerEgressAllowed(
  request: Request,
  publicOrigin?: string,
  dependencies = false,
) {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.port || url.username || url.password)
    return false;
  const read = request.method === "GET" || request.method === "HEAD";
  if (url.hostname === "registry.npmjs.org")
    return (
      dependencies &&
      read &&
      !url.search &&
      (/^\/(?:@[a-z0-9._-]+(?:\/|%2[fF]))?[a-z0-9._-]+$/.test(url.pathname) ||
        /^\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/-\/[a-zA-Z0-9._-]+\.tgz$/.test(
          url.pathname,
        ))
    );
  if (url.hostname === "github.com")
    return (
      (read || request.method === "POST") &&
      /^\/[\w.-]+\/[\w.-]+\.git\/(?:info\/refs|git-upload-pack)$/.test(
        url.pathname,
      )
    );
  if (url.hostname === "api.github.com")
    return (
      read &&
      /^\/repos\/[\w.-]+\/[\w.-]+\/(?:issues|pulls)\/\d+$/.test(url.pathname)
    );
  if (url.hostname === "chatgpt.com")
    return (
      (read || request.method === "POST") &&
      url.pathname.startsWith("/backend-api/codex/")
    );
  if (publicOrigin && url.origin === publicOrigin)
    return (
      request.method === "POST" &&
      !url.search &&
      /^\/_runner\/runs\/[a-f0-9-]+\/(?:credentials|publication|diagnostics|network-closed)$/.test(
        url.pathname,
      )
    );
  return false;
}

export class RunnerEgress extends WorkerEntrypoint<
  Pick<Bindings, "TAILOS_PUBLIC_ORIGIN">
> {
  async fetch(request: Request): Promise<Response> {
    if (!runnerEgressAllowed(request, this.env.TAILOS_PUBLIC_ORIGIN))
      return new Response("Runner egress denied", { status: 403 });
    return fetch(request, { redirect: "manual" });
  }
}

// Registered only during trusted prefetch; replaced with RunnerEgress before
// any repository or Agent code can execute.
export class DependencyEgress extends WorkerEntrypoint<Bindings> {
  fetch(request: Request): Promise<Response> | Response {
    if (
      new URL(request.url).hostname !== "registry.npmjs.org" ||
      !runnerEgressAllowed(request, undefined, true)
    )
      return new Response("Dependency egress denied", { status: 403 });
    return fetch(new URL(request.url), {
      method: request.method,
      redirect: "manual",
    });
  }
}

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "@/bindings.ts";

/** The GitHub hosts whose HTTPS traffic from a Run's container is intercepted. */
export const githubEgressHosts = ["github.com", "api.github.com"] as const;

/** The Run whose token is added, and the Session whose Runner holds it. */
export type GitHubEgressProps = { runId: string; sessionId: string };

const denied = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

/**
 * Forwards an intercepted GitHub request with the Run's token added.
 *
 * Interception matches the TLS server name, while the request URL comes from
 * the Host header that the container controls, so the URL is checked again
 * before any credential is attached.
 */
export async function forwardGitHubRequest(
  request: Request,
  token: () => Promise<string | null | undefined>,
  upstream: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    !(githubEgressHosts as readonly string[]).includes(url.hostname)
  )
    return denied(403, "Tailos forwards only GitHub requests here.");
  const value = await token().catch(() => null);
  if (!value)
    return denied(403, "GitHub access for this Run is no longer available.");

  const headers = new Headers(request.headers);
  // The container only has a placeholder; never forward its credentials.
  for (const name of ["authorization", "proxy-authorization", "cookie"])
    headers.delete(name);
  headers.set(
    "Authorization",
    url.hostname === "github.com"
      ? `Basic ${btoa(`x-access-token:${value}`)}`
      : `Bearer ${value}`,
  );
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  // A redirect target is outside this check: return it to the client as is.
  return upstream(
    new Request(url, {
      method: request.method,
      headers,
      // git streams its pack requests; pass the body through unbuffered.
      ...(hasBody && { body: request.body, duplex: "half" }),
      redirect: "manual",
    } as RequestInit),
  );
}

/** Receives a Run container's intercepted HTTPS traffic to GitHub. */
export class GitHubEgress extends WorkerEntrypoint<
  Bindings,
  GitHubEgressProps
> {
  override fetch(request: Request) {
    const { runId, sessionId } = this.ctx.props;
    return forwardGitHubRequest(request, async () =>
      this.env.RUNNER?.getByName(sessionId).githubToken(runId),
    );
  }
}

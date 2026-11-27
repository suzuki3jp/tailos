import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "@/bindings.ts";

/** The GitHub hosts whose HTTPS traffic from a Run's container is intercepted. */
export const githubEgressHosts = ["github.com", "api.github.com"] as const;

/** The Run whose token is added, and the Session whose Runner holds it. */
export type GitHubEgressProps = { sessionId: string; runId?: string };

/** The most of a push's beginning read for the branches it updates. */
const maxPushCommandBytes = 64 * 1024;
const zeroSha = "0".repeat(40);

/**
 * The branches a git push creates or updates, from the commands before its
 * pack, and the push's body to forward unchanged. Nothing of the pack is
 * read. A push whose commands cannot be read names no branches.
 */
export async function readPushedBranches(
  body: ReadableStream<Uint8Array>,
): Promise<{ branches: string[]; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let branches: string[] | undefined;
  const decoder = new TextDecoder();
  // Pkt-lines: a 4-digit hex length that counts itself, then the data;
  // "0000" ends the commands.
  const parse = (data: Uint8Array) => {
    const found: string[] = [];
    let offset = 0;
    while (offset + 4 <= data.length) {
      const hex = decoder.decode(data.subarray(offset, offset + 4));
      if (!/^[0-9a-f]{4}$/.test(hex)) return [];
      const length = Number.parseInt(hex, 16);
      if (length === 0) return found;
      if (length < 4) return [];
      if (offset + length > data.length) return undefined;
      const line = decoder
        .decode(data.subarray(offset + 4, offset + length))
        .split("\0")[0]!
        .replace(/\n$/, "");
      const command = /^([0-9a-f]{40}) ([0-9a-f]{40}) refs\/heads\/(\S+)$/.exec(
        line,
      );
      if (command && command[2] !== zeroSha) found.push(command[3]!);
      offset += length;
    }
    return undefined;
  };
  while (branches === undefined && size < maxPushCommandBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    const data = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }
    branches = parse(data);
  }
  const replay = chunks;
  return {
    branches: [...new Set(branches ?? [])],
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = replay.shift();
        if (next) {
          controller.enqueue(next);
          return;
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    }),
  };
}

/** The repository a git push goes to, as `owner/name`; none for other requests. */
function pushRepository(request: Request, url: URL) {
  if (
    request.method !== "POST" ||
    url.hostname !== "github.com" ||
    request.headers.get("content-encoding")
  )
    return undefined;
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/git-receive-pack$/.exec(
    url.pathname,
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

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
  recordPush?: (repository: string, branches: string[]) => Promise<void>,
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
  let body = request.body;
  // The Run's result shows the pull requests of the branches it pushed.
  const repository = pushRepository(request, url);
  if (recordPush && body && repository) {
    const push = await readPushedBranches(body);
    body = push.body;
    if (push.branches.length)
      await recordPush(repository, push.branches).catch(() => {});
  }
  // A redirect target is outside this check: return it to the client as is.
  return upstream(
    new Request(url, {
      method: request.method,
      headers,
      // git streams its pack requests; pass the body through unbuffered.
      ...(hasBody && { body, duplex: "half" }),
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
    const runner = this.env.RUNNER?.getByName(sessionId);
    return forwardGitHubRequest(
      request,
      async () => runner?.githubToken(runId),
      fetch,
      async (repository, branches) =>
        runner?.recordPush(runId, repository, branches),
    );
  }
}

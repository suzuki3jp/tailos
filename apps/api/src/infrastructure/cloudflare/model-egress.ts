import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "@/bindings.ts";

/** The model API hosts whose HTTPS traffic from a Codex Run is intercepted. */
export const codexEgressHosts = ["chatgpt.com"] as const;

/**
 * The paths that Codex uses for a Run: the model API under `codex/`, the
 * workspace routing discovery that Codex runs before its first model request,
 * and the usage query. The token is not added to the rest of the account's
 * API.
 */
const codexPathPrefixes = ["/backend-api/codex/"] as const;
const codexPaths = [
  "/backend-api/wham/accounts/check",
  "/backend-api/wham/usage",
] as const;

/** Whether a path is one Codex uses, without encoded separators or dots. */
export function isCodexPath(pathname: string) {
  if (/%2e|%2f|%5c|\\/i.test(pathname)) return false;
  return (
    (codexPaths as readonly string[]).includes(pathname) ||
    codexPathPrefixes.some((prefix) => pathname.startsWith(prefix))
  );
}

/** The Run whose access is added, and the Session whose Runner holds it. */
export type ModelEgressProps = { sessionId: string; runId?: string };

/** The Run's current Codex access, issued outside the container. */
export type ModelAccess = {
  accessToken: string;
  accountId: string;
  accessVersion: string;
};

const denied = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

/**
 * Forwards an intercepted Codex model request with the Run's access token.
 *
 * The container holds only a placeholder token. Interception matches the TLS
 * server name, while the request URL comes from the Host header that the
 * container controls, so the URL is checked again before the token is added.
 * Only the paths Codex uses receive the token, since any process in the
 * container can reach the host.
 * WebSocket upgrades pass through unchanged apart from the credentials.
 */
export async function forwardModelRequest(
  request: Request,
  access: () => Promise<ModelAccess | null | undefined>,
  rejected: (accessVersion: string) => Promise<void>,
  upstream: typeof fetch = fetch,
  runId?: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    !(codexEgressHosts as readonly string[]).includes(url.hostname) ||
    !isCodexPath(url.pathname)
  ) {
    // A Codex update may need a path that is not allowed yet: name it in the
    // logs. Only the Run, host and path are recorded, never headers or the query.
    // oxlint-disable-next-line no-console -- Record denied paths without credentials.
    console.warn("Model egress denied a request", {
      runId,
      host: url.hostname,
      path: url.pathname,
    });
    return denied(403, "Tailos forwards only model API requests here.");
  }
  const current = await access().catch(() => null);
  if (!current)
    return denied(401, "Model access for this Run is no longer available.");

  const headers = new Headers(request.headers);
  // Never forward what the container sent as credentials.
  for (const name of ["authorization", "proxy-authorization", "cookie"])
    headers.delete(name);
  headers.set("Authorization", `Bearer ${current.accessToken}`);
  headers.set("ChatGPT-Account-Id", current.accountId);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await upstream(
    new Request(url, {
      method: request.method,
      headers,
      ...(hasBody && { body: request.body, duplex: "half" }),
      redirect: "manual",
    } as RequestInit),
  );
  // Codex then asks for new tokens and retries; the next request refreshes.
  if (response.status === 401)
    await rejected(current.accessVersion).catch(() => {});
  return response;
}

/** Receives a Codex Run container's intercepted model API traffic. */
export class ModelEgress extends WorkerEntrypoint<Bindings, ModelEgressProps> {
  override fetch(request: Request) {
    const { runId, sessionId } = this.ctx.props;
    const runner = () => this.env.RUNNER?.getByName(sessionId);
    return forwardModelRequest(
      request,
      async () => runner()?.modelAccess(runId),
      async (accessVersion) =>
        runner()?.rejectModelAccess(runId, accessVersion),
      fetch,
      runId,
    );
  }
}

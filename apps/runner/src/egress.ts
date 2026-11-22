import { lookup } from "node:dns/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";

/**
 * Where the container's trust settings live. The entrypoint adds the CA that
 * Cloudflare uses for intercepted GitHub traffic when the Run has one.
 */
const trustVariables = [
  "SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** The CA settings that the Runner's own git and the Agent's commands need. */
export function trustEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    trustVariables.flatMap((name) => {
      const value = env[name];
      return value ? [[name, value]] : [];
    }),
  );
}

/**
 * gh refuses to run without a token. The real token is added to GitHub
 * requests outside the container, so the Agent gets only a placeholder.
 * Claude Code removes GH_TOKEN from command environments, so the placeholder
 * goes in gh's configuration under the Agent's HOME instead.
 */
export const githubTokenPlaceholder = "tailos-egress-placeholder";
export async function prepareGitHubCli(home: string) {
  const directory = join(home, ".config", "gh");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "hosts.yml"),
    [
      "github.com:",
      `    oauth_token: ${githubTokenPlaceholder}`,
      "    git_protocol: https",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

// Destinations inside the container or its network: the Runner's control
// port among them. Agent commands reach only the internet through the proxy.
export const internalAddresses = new BlockList();
const internal = internalAddresses;
internal.addSubnet("0.0.0.0", 8, "ipv4");
internal.addSubnet("10.0.0.0", 8, "ipv4");
internal.addSubnet("100.64.0.0", 10, "ipv4");
internal.addSubnet("127.0.0.0", 8, "ipv4");
internal.addSubnet("169.254.0.0", 16, "ipv4");
internal.addSubnet("172.16.0.0", 12, "ipv4");
internal.addSubnet("192.168.0.0", 16, "ipv4");
internal.addAddress("::", "ipv6");
internal.addAddress("::1", "ipv6");
internal.addSubnet("fc00::", 7, "ipv6");
internal.addSubnet("fe80::", 10, "ipv6");

export type ResolveHost = (
  host: string,
) => Promise<{ address: string; family: number }>;
const resolveHost: ResolveHost = (host) => lookup(host);

function isBlocked(address: string, blocked: BlockList) {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  return mapped
    ? blocked.check(mapped, "ipv4")
    : blocked.check(address, "ipv6");
}

function parseAuthority(authority: string | undefined) {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+):(\d{1,5})$/i.exec(authority ?? "");
  const port = Number(match?.[2]);
  return match && port > 0 && port < 65536
    ? { host: match[1]!, port }
    : undefined;
}

function refuse(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

/**
 * A forward proxy for the commands of Claude Code. Its command sandbox only
 * reaches the network through a proxy and cannot allow every host itself, so
 * Tailos supplies this one. It forwards HTTP and HTTPS (CONNECT) to public
 * addresses only.
 */
export async function startEgressProxy({
  resolve = resolveHost,
  blocked = internalAddresses,
}: { resolve?: ResolveHost; blocked?: BlockList } = {}) {
  // Connect to the checked address, so a second lookup cannot change it.
  const publicAddress = async (host: string) => {
    const name = host.replace(/^\[(.*)\]$/, "$1");
    const { address } = isIP(name)
      ? { address: name }
      : await resolve(name).catch(() => ({ address: "" }));
    return address && !isBlocked(address, blocked) ? address : undefined;
  };
  const sockets = new Set<Socket | Duplex>();
  const track = (socket: Socket | Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer(
    async (incoming: IncomingMessage, response: ServerResponse) => {
      let target: URL;
      try {
        target = new URL(incoming.url ?? "");
      } catch {
        response.writeHead(400).end();
        return;
      }
      const address =
        target.protocol === "http:"
          ? await publicAddress(target.hostname)
          : undefined;
      if (!address) {
        response.writeHead(403).end();
        return;
      }
      const headers = { ...incoming.headers };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = httpRequest(
        {
          host: address,
          port: target.port || 80,
          method: incoming.method,
          path: target.pathname + target.search,
          headers: { ...headers, host: target.host },
        },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      incoming.pipe(upstream);
    },
  );
  server.on("connection", track);
  server.on("connect", async (incoming, client: Duplex, head: Buffer) => {
    track(client);
    client.on("error", () => client.destroy());
    const authority = parseAuthority(incoming.url);
    const address = authority && (await publicAddress(authority.host));
    if (!authority || !address) {
      refuse(client, "403 Forbidden");
      return;
    }
    let established = false;
    const upstream = connect(authority.port, address, () => {
      established = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.on("error", () => {
      if (!established) refuse(client, "502 Bad Gateway");
      else client.destroy();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw new Error("Egress proxy address unavailable");
  return {
    port: bound.port,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
}

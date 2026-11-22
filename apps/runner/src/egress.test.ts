import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, request } from "node:http";
import { BlockList, connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import {
  githubTokenPlaceholder,
  prepareGitHubCli,
  startEgressProxy,
  trustEnvironment,
  type ResolveHost,
} from "@/egress.ts";

test("passes on only the CA settings the entrypoint made", () => {
  expect(
    trustEnvironment({
      SSL_CERT_FILE: "/app/tls/ca-bundle.pem",
      GIT_SSL_CAINFO: "/app/tls/ca-bundle.pem",
      NODE_EXTRA_CA_CERTS: "",
      GH_TOKEN: "unrelated",
    }),
  ).toEqual({
    SSL_CERT_FILE: "/app/tls/ca-bundle.pem",
    GIT_SSL_CAINFO: "/app/tls/ca-bundle.pem",
  });
  expect(trustEnvironment({})).toEqual({});
});

test("gives gh a placeholder token that only the egress Worker replaces", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "tailos-gh-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await prepareGitHubCli(home);
  const hosts = join(home, ".config", "gh", "hosts.yml");
  expect(await readFile(hosts, "utf8")).toBe(
    `github.com:\n    oauth_token: ${githubTokenPlaceholder}\n    git_protocol: https\n`,
  );
  expect((await stat(hosts)).mode & 0o777).toBe(0o600);
});

// Resolves every name to the local test server, as if it were public.
async function upstream(t: TestContext) {
  const server = createServer((incoming, response) => {
    response.end(`${incoming.method} ${incoming.url} ${incoming.headers.host}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.onTestFinished(
    () => new Promise<void>((done) => server.close(() => done())),
  );
  return (server.address() as AddressInfo).port;
}

async function proxy(
  t: TestContext,
  resolve: ResolveHost,
  blocked?: BlockList,
) {
  const started = await startEgressProxy({ resolve, blocked });
  t.onTestFinished(() => started.close());
  return started.port;
}

function connectThrough(port: number, authority: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      ),
    );
    socket.once("data", (data) => {
      resolve(data.toString().split("\r\n")[0]!);
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

function getThrough(port: number, url: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: url }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    })
      .on("error", reject)
      .end();
  });
}

test("refuses destinations inside the container or its network", async (t) => {
  const names: Record<string, string> = {
    localhost: "127.0.0.1",
    "runner.internal": "10.0.0.2",
  };
  const port = await proxy(t, async (host) => {
    const address = names[host];
    if (!address) throw new Error("Unexpected lookup");
    return { address, family: 4 };
  });
  for (const authority of [
    "127.0.0.1:8080",
    "localhost:8080",
    "[::1]:8080",
    "10.1.2.3:443",
    "169.254.169.254:80",
    "runner.internal:443",
    "example.com:0",
    "example.com",
  ])
    expect(await connectThrough(port, authority)).toBe(
      "HTTP/1.1 403 Forbidden",
    );
  expect(
    (await getThrough(port, "http://169.254.169.254/latest/meta-data")).status,
  ).toBe(403);
  expect((await getThrough(port, "https://example.com/")).status).toBe(403);
});

test("forwards HTTP and opens tunnels to the address it checked", async (t) => {
  const target = await upstream(t);
  const resolved: string[] = [];
  // The test server is local, so this proxy blocks nothing.
  const port = await proxy(
    t,
    async (host) => {
      resolved.push(host);
      return { address: "127.0.0.1", family: 4 };
    },
    new BlockList(),
  );
  expect(await connectThrough(port, `example.com:${target}`)).toBe(
    "HTTP/1.1 200 Connection Established",
  );
  expect(
    await getThrough(port, `http://example.com:${target}/path?q=1`),
  ).toEqual({
    status: 200,
    body: `GET /path?q=1 example.com:${target}`,
  });
  expect(resolved).toEqual(["example.com", "example.com"]);
});

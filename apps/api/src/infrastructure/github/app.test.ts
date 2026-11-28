import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  Miniflare,
  Response as MiniflareResponse,
  convertV4MiniflareOptions,
} from "miniflare";
import { assert, expect, test } from "vitest";
import { GitHubApp, GitHubRequestError } from "@/infrastructure/github/app.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    format: "pem",
    type: "pkcs1",
  })
  .toString();
const target = {
  repository: "owner/private",
  repositoryId: 42,
  installationId: 19,
  issueNumber: 8,
  defaultBranch: "main",
};
const trigger = {
  kind: "github.issue-label",
  issueNumber: 8,
  label: "tailos:run",
} as const;
const planTrigger = { kind: "github.issue-comment", issueNumber: 8 } as const;
const sha = "a".repeat(40);
const author = {
  name: "tailos-app[bot]",
  email: "77+tailos-app[bot]@users.noreply.github.com",
};
/** The App and its bot account, which a checkout names as the author. */
function appAccount(url: URL) {
  if (url.pathname === "/app") return Response.json({ slug: "tailos-app" });
  if (url.pathname === "/users/tailos-app%5Bbot%5D")
    return Response.json({ id: 77 });
  return undefined;
}

test("sends authenticated GitHub requests from Workers without following redirects", async (t) => {
  const bundled = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      contents: `
        import { GitHubApp } from "@/infrastructure/github/app.ts";
        export default {
          async fetch(request, env) {
            const github = new GitHubApp({ appId: "100", privateKey: env.TEST_PRIVATE_KEY });
            try {
              await github.revoke("test-grant");
              return new Response(null, { status: 204 });
            } catch (error) {
              return new Response(error.message, { status: 502 });
            }
          },
        };
      `,
    },
    bundle: true,
    format: "esm",
    external: ["node:crypto"],
    write: false,
  });
  let redirect = false;
  const outboundUrls: string[] = [];
  const endpoint = "https://api.github.com/installation/token";
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-10-06",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { TEST_PRIVATE_KEY: privateKey },
      outboundService(request) {
        outboundUrls.push(request.url);
        expect(request.method).toBe("DELETE");
        expect(request.headers.get("Authorization")).toBe("Bearer test-grant");
        return redirect
          ? new MiniflareResponse(null, {
              status: 307,
              headers: { Location: "https://unexpected.example/" },
            })
          : new MiniflareResponse(null, { status: 204 });
      },
    }),
  );
  t.onTestFinished(() => worker.dispose());

  const success = await worker.dispatchFetch("http://worker");
  expect(success.status, await success.text()).toBe(204);
  redirect = true;
  const rejected = await worker.dispatchFetch("http://worker");
  expect(rejected.status).toBe(502);
  expect(await rejected.text()).toBe("GitHub token revocation failed");
  expect(outboundUrls).toStrictEqual([endpoint, endpoint]);
});

test("scopes app grants to one repository and protects the default branch and gives the Run every App permission on it", async () => {
  let protectedBranch = false;
  const permissions: (object | undefined)[] = [];
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) {
        const body = JSON.parse(String(init?.body));
        expect(body.repository_ids).toStrictEqual([42]);
        permissions.push(body.permissions);
        return Response.json({
          token: "test-grant",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (url.pathname === "/repos/owner/private")
        return Response.json({ id: 42, default_branch: "main" });
      if (url.pathname.endsWith("/issues/8"))
        return Response.json({
          state: "open",
          labels: [{ name: "tailos:run" }],
        });
      if (url.pathname.endsWith("/rules/branches/main")) {
        return Response.json(
          protectedBranch
            ? ["creation", "update", "deletion"].map((type) => ({ type }))
            : [],
        );
      }
      if (url.pathname.endsWith("/git/ref/heads/main"))
        return Response.json({ object: { sha } });
      const account = appAccount(url);
      if (account) return account;
      expect(url.pathname).toBe("/installation/token");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    },
  );

  await expect(github.checkout(target, trigger)).rejects.toThrow(
    /active creation/,
  );
  expect(permissions).toStrictEqual([{ contents: "read", issues: "read" }]);
  protectedBranch = true;
  const { expiresAt, ...checkout } = await github.checkout(target, trigger);
  assert(expiresAt > Date.now());
  // The Agent's commits are by the App's bot account.
  expect(checkout).toStrictEqual({ token: "test-grant", baseSha: sha, author });
  // The Run's grant omits permissions: it gets what the App was granted,
  // still for the target repository only.
  expect(permissions).toStrictEqual([
    { contents: "read", issues: "read" },
    { contents: "read", issues: "read" },
    undefined,
  ]);
});

test("a Run without an issue checks out without reading an issue", async () => {
  const webTrigger = { kind: "web.message" } as const;
  const paths: string[] = [];
  const repo = { id: 42, default_branch: "main" };
  const github = new GitHubApp({ appId: "100", privateKey }, async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "test-grant",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      });
    if (url.pathname === "/repos/owner/private") return Response.json(repo);
    if (url.pathname.endsWith("/rules/branches/main"))
      return Response.json(
        ["creation", "update", "deletion"].map((type) => ({ type })),
      );
    if (url.pathname.includes("/git/ref/heads/"))
      return Response.json({ object: { sha } });
    const account = appAccount(url);
    if (account) return account;
    expect(url.pathname).toBe("/installation/token");
    return new Response(null, { status: 204 });
  });
  expect((await github.checkout(target, webTrigger)).baseSha).toBe(sha);
  expect(paths.some((path) => path.includes("/issues/"))).toBe(false);
});

test("finds the newest pull request of each pushed branch in the target repository", async () => {
  const repo = { id: 42, default_branch: "main" };
  const fork = { id: 99, default_branch: "main" };
  const pull = (number: number, head: string, headRepo = repo) => ({
    html_url: `https://github.com/owner/private/pull/${number}`,
    base: { ref: "main", repo },
    head: { ref: head, sha, repo: headRepo },
  });
  const permissions: unknown[] = [];
  const queries: string[] = [];
  let revoked = 0;
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) {
        permissions.push(JSON.parse(String(init?.body)).permissions);
        return Response.json({
          token: "read-grant",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (url.pathname === "/repos/owner/private/pulls") {
        const head = url.searchParams.get("head");
        queries.push(head!);
        expect(url.searchParams.get("state")).toBe("all");
        if (head === "owner:feature")
          return Response.json([pull(7, "feature", fork), pull(5, "feature")]);
        if (head === "owner:broken")
          return Response.json({ message: "error" }, { status: 500 });
        return Response.json([]);
      }
      expect(url.pathname).toBe("/installation/token");
      revoked++;
      return new Response(null, { status: 204 });
    },
  );
  expect(
    await github.branchPullRequests(target, ["feature", "none", "broken"]),
  ).toStrictEqual([
    { branch: "feature", url: "https://github.com/owner/private/pull/5" },
  ]);
  expect(queries).toStrictEqual([
    "owner:feature",
    "owner:none",
    "owner:broken",
  ]);
  expect(permissions).toStrictEqual([{ pull_requests: "read" }]);
  expect(revoked).toBe(1);
  // Nothing pushed needs no token.
  expect(await github.branchPullRequests(target, [])).toStrictEqual([]);
  expect(permissions).toHaveLength(1);
});

test.for([
  "<!-- tailos:run:run:v1 -->",
  "<!-- tailos:plan:run:input:1:reply:v1 -->",
])(
  "recovers an ambiguous comment across all pages and rejects copied markers: %s",
  async (marker) => {
    const calls: string[] = [];
    let posted = false;
    const github = new GitHubApp(
      { appId: "100", privateKey },
      async (input, init) => {
        const url = new URL(String(input));
        calls.push(`${init?.method} ${url.pathname}${url.search}`);
        if (url.pathname.endsWith("/access_tokens")) {
          expect(JSON.parse(String(init?.body)).permissions).toEqual({
            issues: "write",
          });
          return Response.json({
            token: "grant",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        if (init?.method === "POST") {
          posted = true;
          throw new Error("Response lost after posting");
        }
        if (init?.method === "PATCH") {
          expect(url.pathname).toBe("/repos/owner/private/issues/comments/123");
          return Response.json({ id: 123 });
        }
        const comment = {
          id: 1,
          body: marker,
          user: { type: "User" },
          performed_via_github_app: null,
        };
        if (url.searchParams.get("page") === "1")
          return Response.json(
            Array.from({ length: 100 }, (_, index) =>
              index % 2
                ? comment
                : {
                    ...comment,
                    user: { type: "Bot" },
                    performed_via_github_app: { id: 999 },
                  },
            ),
          );
        if (!posted) return Response.json([]);
        return Response.json([
          {
            ...comment,
            id: 123,
            user: { type: "Bot" },
            performed_via_github_app: { id: 100 },
          },
        ]);
      },
    );
    await expect(
      github.issueComment(target, marker, "terminal", null),
    ).rejects.toThrow("Response lost after posting");
    expect(await github.issueComment(target, marker, "terminal", null)).toBe(
      123,
    );
    expect(calls.some((c) => c.includes("page=2"))).toBe(true);
    expect(
      calls.filter((c) => c.startsWith("POST") && c.includes("/comments")),
    ).toHaveLength(1);
    expect(calls.at(-1)).toBe("DELETE /installation/token");
  },
);

test.for([
  [403, {}, "permission", "Resource not accessible by integration"],
  [410, {}, "permanent", "Issues are disabled for this repository"],
  [400, {}, "permanent", "Bad Request"],
  [429, { "retry-after": "120" }, "rate_limit", ""],
  [
    403,
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
    "rate_limit",
    "",
  ],
  [
    403,
    { "x-ratelimit-remaining": "4000" },
    "rate_limit",
    "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
  ],
  [429, {}, "rate_limit", "You have exceeded a secondary rate limit."],
  [
    422,
    {},
    "transient",
    "Validation failed, or the endpoint has been spammed.",
  ],
  [503, {}, "transient", "Service unavailable"],
] as const)(
  "classifies comment API failures %s",
  async ([status, headers, category, message]) => {
    let revoked = false;
    const github = new GitHubApp(
      { appId: "100", privateKey },
      async (input, init) => {
        if (String(input).endsWith("/access_tokens"))
          return Response.json({
            token: "grant",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          });
        if (init?.method === "DELETE") {
          revoked = true;
          return new Response(null, { status: 204 });
        }
        return Response.json({ message }, { status, headers });
      },
    );
    await expect(
      github.issueComment(target, "marker", "body", 123),
    ).rejects.toMatchObject({ category });
    expect(revoked).toBe(true);
  },
);

test("keeps HTTP status on failures outside issue notifications", async () => {
  const github = new GitHubApp({ appId: "100", privateKey }, async () =>
    Response.json({ message: "Not found" }, { status: 404 }),
  );
  await expect(github.checkout(target, trigger)).rejects.toBeInstanceOf(
    GitHubRequestError,
  );
  await expect(github.checkout(target, trigger)).rejects.toMatchObject({
    status: 404,
    message: "GitHub request failed (404)",
  });
});

test("reconciles and recreates a deleted comment before completing delivery", async () => {
  const calls: string[] = [];
  const marker = "<!-- tailos:run:deleted:v1 -->";
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method} ${url.pathname}`);
      if (url.pathname.endsWith("/access_tokens"))
        return Response.json({
          token: "grant",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "PATCH")
        return Response.json({ message: "Not Found" }, { status: 404 });
      if (init?.method === "GET") return Response.json([]);
      expect(JSON.parse(String(init?.body)).body).toBe(marker);
      return Response.json({ id: 456 });
    },
  );
  expect(await github.issueComment(target, marker, marker, 123)).toBe(456);
  expect(calls).toEqual([
    "POST /app/installations/19/access_tokens",
    "PATCH /repos/owner/private/issues/comments/123",
    "GET /repos/owner/private/issues/8/comments",
    "POST /repos/owner/private/issues/8/comments",
    "DELETE /installation/token",
  ]);
});

test("adopts an App comment after the successful POST response was lost", async () => {
  let created = false;
  let posts = 0;
  let revoked = 0;
  const marker = "<!-- tailos:run:lost:v1 -->";
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens"))
        return Response.json({
          token: "grant",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      if (init?.method === "DELETE") {
        revoked++;
        return new Response(null, { status: 204 });
      }
      if (init?.method === "POST") {
        expect(url.pathname).toBe("/repos/owner/private/issues/8/comments");
        posts++;
        created = true;
        throw new Error("response lost");
      }
      if (init?.method === "PATCH") {
        expect(JSON.parse(String(init.body)).body).toBe("finished " + marker);
        return Response.json({ id: 321 });
      }
      return Response.json(
        created
          ? [
              {
                id: 321,
                body: marker,
                user: { type: "Bot" },
                performed_via_github_app: { id: 100 },
              },
            ]
          : [],
      );
    },
  );
  await expect(
    github.issueComment(target, marker, marker, null),
  ).rejects.toThrow("response lost");
  expect(
    await github.issueComment(target, marker, "finished " + marker, null),
  ).toBe(321);
  expect(posts).toBe(1);
  expect(revoked).toBe(2);
});

test("a comment Turn checks out an unlabelled issue once the default branch is protected", async () => {
  // Every Turn may push, planning included.
  let rules: { type: string }[] = [];
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access_tokens")) {
        const body = JSON.parse(String(init?.body));
        expect(body.repository_ids).toEqual([42]);
        // Checks use read grants; the Run's grant has the App's permissions.
        expect(
          Object.values(body.permissions ?? { all: "read" }).every(
            (permission) => permission === "read",
          ),
        ).toBe(true);
        return Response.json({
          token: "read-grant",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (path === "/repos/owner/private")
        return Response.json({ id: 42, default_branch: "main" });
      if (path.endsWith("/issues/8"))
        return Response.json({
          state: "open",
          labels: [],
          title: "Plan issue",
          body: "Current body",
        });
      if (path.endsWith("/rules/branches/main")) return Response.json(rules);
      if (path.endsWith("/git/ref/heads/main"))
        return Response.json({ object: { sha } });
      const account = appAccount(new URL(String(input)));
      if (account) return account;
      expect(path).toBe("/installation/token");
      return new Response(null, { status: 204 });
    },
  );
  await expect(github.checkout(target, planTrigger)).rejects.toThrow(
    /restrictions/,
  );
  rules = [{ type: "creation" }, { type: "update" }, { type: "deletion" }];
  expect((await github.checkout(target, planTrigger)).baseSha).toBe(sha);
  await expect(github.checkout(target, trigger)).rejects.toThrow(/trigger/);
});

test("project repository discovery pages installations and repositories, uses metadata-only grants, and never exposes tokens", async () => {
  const paths: string[] = [];
  const grants: object[] = [];
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname + url.search);
      if (url.pathname === "/app/installations") {
        expect(init?.headers).toMatchObject({
          Authorization: expect.stringMatching(/^Bearer /),
        });
        return Response.json(
          url.searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, (_, i) => ({
                id: i + 1,
                suspended_at: i === 0 ? null : "2026-11-14T00:00:00Z",
              }))
            : [{ id: 101, suspended_at: null }],
        );
      }
      if (url.pathname.endsWith("/access_tokens")) {
        const body = JSON.parse(String(init?.body));
        grants.push(body);
        expect(body.permissions).toEqual({ metadata: "read" });
        return Response.json({
          token: "metadata-token",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (url.pathname === "/installation/repositories")
        return Response.json({
          repositories:
            url.searchParams.get("page") === "1"
              ? Array.from({ length: 100 }, (_, i) => ({
                  id: i + 1,
                  full_name: `owner/repo-${i + 1}`,
                }))
              : [{ id: 101, full_name: "owner/final" }],
        });
      if (url.pathname === "/installation/token") {
        expect(init?.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      }
      throw new Error("Unexpected URL " + url);
    },
  );
  const choices = await github.projectRepositories().list();
  expect(paths).toContain("/app/installations?per_page=100&page=2");
  expect(
    paths.filter(
      (path) => path === "/installation/repositories?per_page=100&page=2",
    ),
  ).toHaveLength(2);
  expect(choices).toHaveLength(202);
  expect(choices).toContainEqual({
    repository: "owner/final",
    repositoryId: 101,
    installationId: 101,
  });
  expect(grants).toHaveLength(2);
  expect(JSON.stringify(choices)).not.toContain("metadata-token");
  expect(paths.filter((path) => path === "/installation/token")).toHaveLength(
    2,
  );
});

test("project saves verify selected repository IDs with the configured App and revoke even on a mismatch", async () => {
  let mismatch = false;
  let revokes = 0;
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/app/installations/19/access_tokens") {
        expect(JSON.parse(String(init?.body))).toEqual({
          repository_ids: [42],
          permissions: { metadata: "read" },
        });
        return Response.json({
          token: "scoped-token",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (url.pathname === "/repos/owner/private")
        return Response.json({
          id: mismatch ? 43 : 42,
          full_name: "owner/private",
        });
      if (url.pathname === "/installation/token") {
        revokes++;
        return new Response(null, { status: 204 });
      }
      throw new Error("Unexpected URL");
    },
  );
  await github.projectRepositories().verify(target);
  mismatch = true;
  await expect(github.projectRepositories().verify(target)).rejects.toThrow(
    /target changed/,
  );
  expect(revokes).toBe(2);
});

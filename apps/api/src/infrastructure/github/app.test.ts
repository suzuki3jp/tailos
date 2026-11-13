import { generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  Miniflare,
  Response as MiniflareResponse,
  convertV4MiniflareOptions,
} from "miniflare";
import { assert, expect, test } from "vitest";
import {
  GitHubApp,
  GitHubRequestError,
  workBranchFor,
} from "@/infrastructure/github/app.ts";

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
  triggerLabel: "tailos:run",
};
const sha = "a".repeat(40);
const pullUrl = "https://github.com/owner/private/pull/32";

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

test("scopes app grants to one repository and protects the default branch and gives the Runner a read-only grant", async () => {
  let protectedBranch = false;
  const permissions: object[] = [];
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
      expect(url.pathname).toBe("/installation/token");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    },
  );

  const runId = randomUUID();
  await expect(github.checkout(target, runId)).rejects.toThrow(
    /active creation/,
  );
  expect(permissions).toStrictEqual([{ contents: "read", issues: "read" }]);
  protectedBranch = true;
  const { expiresAt, ...checkout } = await github.checkout(target, runId);
  assert(expiresAt > Date.now());
  expect(checkout).toStrictEqual({
    token: "test-grant",
    baseSha: sha,
    branch: workBranchFor(target, runId),
  });
  expect(permissions).toStrictEqual([
    { contents: "read", issues: "read" },
    { contents: "read", issues: "read" },
    { contents: "read", issues: "read", pull_requests: "read" },
  ]);
});

test("reuses the pull request after a lost response and never publishes a different ref", async () => {
  const runId = randomUUID();
  const branch = workBranchFor(target, runId);
  const headline = "fix(api): handle refresh";
  const repo = { id: 42, default_branch: "main" };
  const pull = {
    html_url: pullUrl,
    base: { ref: "main", repo },
    head: { ref: branch, sha, repo },
  };
  let created = 0;
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toStrictEqual({
          repository_ids: [42],
          permissions: { contents: "read", pull_requests: "write" },
        });
        return Response.json({
          token: "test-pr-grant",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (url.pathname.includes("/git/ref/heads/"))
        return Response.json({ object: { sha } });
      if (url.pathname.endsWith("/pulls")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          expect(body.head).toBe(branch);
          expect(body.base).toBe("main");
          expect(body.title).toBe(headline);
          created++;
          throw new Error("Response lost after creation");
        }
        expect(url.searchParams.get("head")).toBe("owner:" + branch);
        return Response.json(created ? [pull] : []);
      }
      expect(url.pathname).toBe("/installation/token");
      return new Response(null, { status: 204 });
    },
  );

  await expect(
    github.publish(target, runId, { branch: "main", sha }),
  ).rejects.toThrow(/Unexpected work branch/);
  await expect(
    github.publish(target, runId, { branch, sha, headline }),
  ).rejects.toThrow(/Response lost/);
  expect(await github.publish(target, runId, { branch, sha, headline })).toBe(
    pullUrl,
  );
  expect(created).toBe(1);
});

test("checks a lost push using a read-only grant and treats absent or different refs as unpushed", async () => {
  const runId = randomUUID();
  const work = { branch: workBranchFor(target, runId), sha };
  let remote: string | null = null;
  let revocations = 0;
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body))).toStrictEqual({
          repository_ids: [42],
          permissions: { contents: "read" },
        });
        return Response.json({
          token: "read-only-grant",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (url.pathname.includes("/git/ref/heads/")) {
        return remote
          ? Response.json({ object: { sha: remote } })
          : new Response(null, { status: 404 });
      }
      expect(url.pathname).toBe("/installation/token");
      expect(init?.method).toBe("DELETE");
      revocations++;
      return new Response(null, { status: 204 });
    },
  );
  expect(await github.hasCommit(target, runId, work)).toBe(false);
  remote = "b".repeat(40);
  expect(await github.hasCommit(target, runId, work)).toBe(false);
  remote = sha;
  expect(await github.hasCommit(target, runId, work)).toBe(true);
  expect(revocations).toBe(3);
});

test("reconciles a lost signing response only for the verified commit with the expected tree", async () => {
  const runId = randomUUID();
  const work = {
    branch: workBranchFor(target, runId),
    baseSha: sha,
    tree: "b".repeat(40),
    headline: "refactor(api): organize handlers",
    changes: {
      additions: [{ path: "handler.ts", contents: "Cg==" }],
      deletions: [],
    },
  };
  const signedSha = "c".repeat(40);
  let head: string | null = null;
  let verified = true;
  let tree = work.tree;
  let mutations = 0;
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          repository_ids: [42],
          permissions: { contents: "write" },
        });
        return Response.json({
          token: "write-grant",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (url.pathname.includes("/git/ref/heads/")) {
        expect(decodeURIComponent(url.pathname)).toBe(
          "/repos/owner/private/git/ref/heads/" + work.branch,
        );
        return head
          ? Response.json({ object: { sha: head } })
          : new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/git/refs")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          ref: "refs/heads/" + work.branch,
          sha: work.baseSha,
        });
        head = work.baseSha;
        return Response.json({ object: { sha: head } }, { status: 201 });
      }
      if (url.pathname === "/graphql") {
        expect(JSON.parse(String(init?.body)).variables.input).toEqual({
          branch: {
            repositoryNameWithOwner: "owner/private",
            branchName: work.branch,
          },
          expectedHeadOid: work.baseSha,
          message: { headline: work.headline, body: "Tailos run: " + runId },
          fileChanges: work.changes,
        });
        mutations++;
        head = signedSha;
        throw new Error("Response lost after signing");
      }
      if (url.pathname.endsWith("/git/commits/" + signedSha))
        return Response.json({
          sha: signedSha,
          tree: { sha: tree },
          parents: [{ sha: work.baseSha }],
          message: work.headline + "\n\nTailos run: " + runId,
          verification: { verified },
        });
      expect(url.pathname).toBe("/installation/token");
      return new Response(null, { status: 204 });
    },
  );

  const sign = () =>
    github.commitCheckedWork(target, runId, work, Date.now() + 10_000);
  await expect(sign()).rejects.toThrow("Response lost");
  await expect(sign()).resolves.toBe(signedSha);
  verified = false;
  await expect(sign()).rejects.toThrow();
  verified = true;
  tree = "d".repeat(40);
  await expect(sign()).rejects.toThrow(
    "GitHub commit does not match checked work",
  );
  expect(mutations).toBe(1);
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
  await expect(github.checkout(target, "run")).rejects.toBeInstanceOf(
    GitHubRequestError,
  );
  await expect(github.checkout(target, "run")).rejects.toMatchObject({
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

test("planning checks out an unlabelled issue without publication branch rules", async () => {
  const github = new GitHubApp(
    { appId: "100", privateKey },
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access_tokens")) {
        const body = JSON.parse(String(init?.body));
        expect(body.repository_ids).toEqual([42]);
        expect(
          Object.values(body.permissions).every(
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
      if (path.endsWith("/git/ref/heads/main"))
        return Response.json({ object: { sha } });
      expect(path).toBe("/installation/token");
      return new Response(null, { status: 204 });
    },
  );
  expect((await github.checkout(target, randomUUID(), "plan")).baseSha).toBe(
    sha,
  );
  await expect(github.checkout(target, randomUUID())).rejects.toThrow(
    /trigger/,
  );
});

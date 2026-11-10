import { generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  Miniflare,
  Response as MiniflareResponse,
  convertV4MiniflareOptions,
} from "miniflare";
import { assert, expect, test } from "vitest";
import { GitHubApp, workBranchFor } from "#api/infrastructure/github/app.ts";

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
        import { GitHubApp } from "#api/infrastructure/github/app.ts";
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

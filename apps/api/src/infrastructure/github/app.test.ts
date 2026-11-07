import { generateKeyPairSync, randomUUID } from "node:crypto";
import { assert, expect, test } from "vitest";
import { GitHubApp, workBranchFor } from "./app.ts";

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
  triggerLabel: "meguri:run",
};
const sha = "a".repeat(40);
const pullUrl = "https://github.com/owner/private/pull/32";

test("scopes app grants to one repository and protects the default branch before granting write", async () => {
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
          labels: [{ name: "meguri:run" }],
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
    { contents: "write" },
  ]);
});

test("reuses the pull request after a lost response and never publishes a different ref", async () => {
  const runId = randomUUID();
  const branch = workBranchFor(target, runId);
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
  await expect(github.publish(target, runId, { branch, sha })).rejects.toThrow(
    /Response lost/,
  );
  expect(await github.publish(target, runId, { branch, sha })).toBe(pullUrl);
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

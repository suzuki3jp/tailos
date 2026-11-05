import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
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
        assert.deepEqual(body.repository_ids, [42]);
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
      assert.equal(url.pathname, "/installation/token");
      assert.equal(init?.method, "DELETE");
      return new Response(null, { status: 204 });
    },
  );

  const runId = randomUUID();
  await assert.rejects(github.checkout(target, runId), /active creation/);
  assert.deepEqual(permissions, [{ contents: "read", issues: "read" }]);
  protectedBranch = true;
  const { expiresAt, ...checkout } = await github.checkout(target, runId);
  assert.ok(expiresAt > Date.now());
  assert.deepEqual(checkout, {
    token: "test-grant",
    baseSha: sha,
    branch: workBranchFor(target, runId),
  });
  assert.deepEqual(permissions, [
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
        assert.deepEqual(body, {
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
          assert.equal(body.head, branch);
          assert.equal(body.base, "main");
          created++;
          throw new Error("Response lost after creation");
        }
        assert.equal(url.searchParams.get("head"), "owner:" + branch);
        return Response.json(created ? [pull] : []);
      }
      assert.equal(url.pathname, "/installation/token");
      return new Response(null, { status: 204 });
    },
  );

  await assert.rejects(
    github.publish(target, runId, { kind: "pushed", branch: "main", sha }),
    /Unexpected work branch/,
  );
  await assert.rejects(
    github.publish(target, runId, { kind: "pushed", branch, sha }),
    /Response lost/,
  );
  assert.equal(
    await github.publish(target, runId, { kind: "pushed", branch, sha }),
    pullUrl,
  );
  assert.equal(created, 1);
});

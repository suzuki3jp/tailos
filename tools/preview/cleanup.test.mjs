import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcile } from "./cleanup.mjs";

test("reconciles every page, retries partial cleanup, and preserves open or unverified PRs", async (t) => {
  const env = process.env;
  t.after(() => {
    process.env = env;
  });
  process.env = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "fake-cloudflare-token",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "example/tailos",
    GH_TOKEN: "fake-github-token",
  };
  const remaining = {
    "tailos-preview-api": ["pr-12", "experiment", "pr-10"],
    "tailos-preview-web": ["pr-12", "pr-11", "pr-10"],
  };
  const deletes = [];
  let failApi = true;
  t.mock.method(globalThis, "fetch", async (input, { method } = {}) => {
    const url = new URL(input);
    if (url.hostname === "api.github.com") {
      const number = Number(url.pathname.split("/").at(-1));
      if (number === 12) return Response.json({}, { status: 500 });
      return Response.json({
        number,
        state: number === 11 ? "open" : "closed",
      });
    }
    const [, worker, name] =
      /\/(tailos-preview-(?:api|web))\/previews(?:\/(.+))?$/.exec(url.pathname);
    if (method === "DELETE") {
      deletes.push(`${worker}/${name}`);
      if (worker.endsWith("-api") && failApi)
        return Response.json(
          { success: false, errors: [{ code: 5000 }] },
          { status: 500 },
        );
      remaining[worker] = remaining[worker].filter(
        (candidate) => candidate !== name,
      );
      return Response.json({ success: true });
    }
    const page = Number(url.searchParams.get("page"));
    return Response.json({
      success: true,
      result: remaining[worker].slice(page - 1, page).map((name) => ({ name })),
      result_info: { total_pages: remaining[worker].length },
    });
  });

  await assert.rejects(reconcile(), AggregateError);
  assert.deepEqual(deletes.sort(), [
    "tailos-preview-api/pr-10",
    "tailos-preview-web/pr-10",
  ]);
  failApi = false;
  deletes.length = 0;
  await assert.rejects(reconcile(), AggregateError);
  assert.deepEqual(deletes, ["tailos-preview-api/pr-10"]);
  assert.deepEqual(remaining["tailos-preview-web"], ["pr-12", "pr-11"]);
  assert.deepEqual(remaining["tailos-preview-api"], ["pr-12", "experiment"]);
});

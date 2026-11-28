import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("publishes Previews using Wrangler's output file when stdout contains module logs", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "tailos-preview-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("./deploy.mjs", import.meta.url));
  const output = join(temp, "github-output");
  const upstream =
    "https://a1b2c3d4-tailos-preview-api.preview-account.workers.dev";
  const web = "https://pr-123.preview.tailos.app";
  writeFileSync(
    join(temp, "pnpm"),
    `#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const args = process.argv.slice(2);
const api = args[1] === "@tailos/api";
const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1]));
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, api);
if (api) assert.equal(config.previews.vars.TAILOS_WEB_ORIGIN, "${web}");
else assert.equal(config.previews.vars.TAILOS_PREVIEW_API_ORIGIN, "${upstream}");
const preview = {
  type: "preview", version: 1,
  worker_name: api ? "tailos-preview-api" : "tailos-preview-web",
  preview_name: "pr-123",
  preview_urls: [api ? "https://pr-123-tailos-preview-api.preview-account.workers.dev" : "${web}"],
  deployment_id: "a1b2c3d4-1234-1234-1234-123456789abc",
  deployment_urls: api ? ["${upstream}"] : [],
};
console.log("Attaching additional modules:");
console.log(JSON.stringify({ preview, deployment: {} }, null, 2));
fs.writeFileSync(
  process.env.WRANGLER_OUTPUT_FILE_PATH,
  [JSON.stringify({ type: "wrangler-session", version: 1 }), JSON.stringify(preview)].join("\\n") + "\\n",
  { flag: "wx" },
);
`,
    { mode: 0o700 },
  );
  const mockFetch = join(temp, "fetch.mjs");
  writeFileSync(
    mockFetch,
    `import assert from "node:assert/strict";
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  const ok = (data) => Response.json(data);
  if (url.hostname === "api.cloudflare.com") {
    const path = url.pathname.split("/").slice(5).join("/");
    if (path === "workers/subdomain")
      return ok({ success: true, result: { subdomain: "preview-account" } });
    assert.ok(path.startsWith("d1/database/") || path === "r2/buckets/tailos-preview-run-artifacts");
    const name = path.startsWith("d1/") ? "tailos-preview" : "tailos-preview-run-artifacts";
    return ok({ success: true, result: { name } });
  }
  if (url.origin === "${upstream}") {
    assert.equal(url.pathname, "/health");
    assert.ok(options.headers["X-Tailos-Preview-Proxy"]);
    return ok({ status: "ok", service: "tailos-api" });
  }
  assert.equal(url.origin, "${web}");
  if (url.pathname === "/health") return ok({ status: "ok", service: "tailos-web" });
  if (url.pathname === "/api/v1/account") return new Response(null, { status: 401 });
  assert.equal(url.pathname, "/api/v1/auth/login");
  assert.equal(options.method, "POST");
  const redirect = new URL("https://github.com/login/oauth/authorize");
  redirect.searchParams.set("redirect_uri", "${web}/api/v1/auth/callback/github");
  return Response.redirect(redirect, 303);
};
`,
  );
  const sha = "a".repeat(40);
  const result = spawnSync(
    process.execPath,
    ["--import", mockFetch, script, "123", sha, temp],
    {
      env: {
        PATH: [temp, process.env.PATH].join(delimiter),
        CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
        CLOUDFLARE_API_TOKEN: "test-cloudflare-token",
        TAILOS_PREVIEW_D1_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
        TAILOS_GITHUB_OAUTH_CLIENT_ID: "test-client",
        TAILOS_GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
        TAILOS_OPERATOR_GITHUB_ID: "123",
        BETTER_AUTH_SECRET: "x".repeat(32),
        GITHUB_OUTPUT: output,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), `url=${web}\n`);
});

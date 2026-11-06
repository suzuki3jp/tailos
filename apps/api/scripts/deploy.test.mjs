import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const deploy = fileURLToPath(new URL("./deploy.mjs", import.meta.url));
const sourceConfig = new URL("../wrangler.jsonc", import.meta.url);

test("provisions resources before migrating and deploying, then removes runtime secrets", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "meguri-test-deploy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  copyFileSync(sourceConfig, join(cwd, "wrangler.jsonc"));
  const wrangler = join(cwd, "wrangler");
  const capture = join(cwd, "capture.ndjson");
  const id = "fcb7056f-e824-41f1-b447-b78d1408ab63";
  writeFileSync(
    wrangler,
    `#!/usr/bin/env node
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const record = (event) => fs.appendFileSync(process.env.MEGURI_TEST_CAPTURE, JSON.stringify(event) + "\\n");
    if (args[0] === "d1" && args[1] === "list") {
      record({ command: args.join(" ") });
      console.log(JSON.stringify(fs.existsSync("database") ? [{ name: "meguri", uuid: "${id}" }] : []));
      process.exit(0);
    }
    if (args[1] === "create" || args[2] === "create") {
      record({ command: args.join(" ") });
      fs.writeFileSync(args[0] === "d1" ? "database" : "bucket", "");
      process.exit(0);
    }
    const config = JSON.parse(fs.readFileSync(args.at(-1), "utf8"));
    const secretsPath = args[args.indexOf("--secrets-file") + 1];
    const runtime = args.includes("--secrets-file") && {
      path: secretsPath,
      names: Object.keys(JSON.parse(fs.readFileSync(secretsPath, "utf8"))).sort(),
      privateMode: (fs.statSync(secretsPath).mode & 511) === 384,
    };
    record({
      command: args.slice(0, args.indexOf("--config")), config, runtime, secretInEnvironment: Boolean(process.env.MEGURI_OPERATOR_TOKEN),
    });
  `,
  );
  chmodSync(wrangler, 0o700);

  const fetchStub = join(cwd, "fetch.mjs");
  writeFileSync(
    fetchStub,
    `import assert from "node:assert/strict";
    import { appendFileSync, existsSync } from "node:fs";
    globalThis.fetch = async (url, { headers }) => {
      assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/test-account/r2/buckets/meguri-run-artifacts");
      assert.equal(headers.Authorization, "Bearer test-token");
      appendFileSync(process.env.MEGURI_TEST_CAPTURE, JSON.stringify({ command: "look up R2" }) + "\\n");
      return existsSync("bucket")
        ? Response.json({ success: true, result: { name: "meguri-run-artifacts" } })
        : Response.json({ errors: [{ code: 10006 }] }, { status: 404 });
    };`,
  );
  const env = {
    PATH: cwd + ":" + process.env.PATH,
    MEGURI_TEST_CAPTURE: capture,
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_API_TOKEN: "test-token",
    MEGURI_PROJECTS: "[]",
    MEGURI_OPERATOR_TOKEN: "test-operator",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };
  const runDeploy = (overrides = {}) =>
    spawnSync(process.execPath, ["--import", fetchStub, deploy], {
      cwd,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
  const result = runDeploy();
  assert.equal(result.status, 0, result.stderr);
  const readCalls = () =>
    readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
  const calls = readCalls();
  assert.deepEqual(
    calls.map(({ command }) => command),
    [
      "d1 list --json",
      "d1 create meguri --no-update-config",
      "d1 list --json",
      "look up R2",
      "r2 bucket create meguri-run-artifacts --no-update-config",
      ["d1", "migrations", "apply", "DB", "--remote"],
      ["deploy", "--secrets-file", calls.at(-1).runtime.path],
    ],
  );
  const [migration, published] = calls.slice(-2);
  assert.equal(migration.config.d1_databases[0].database_id, id);
  assert.equal(published.config.d1_databases[0].database_id, id);
  assert.equal(published.config.workers_dev, false);
  assert.deepEqual(published.config.routes, [
    { pattern: "meguri.suzuki3.jp", custom_domain: true },
  ]);
  assert.equal(
    published.config.vars.MEGURI_PUBLIC_ORIGIN,
    "https://meguri.suzuki3.jp",
  );
  assert.equal(published.secretInEnvironment, false);
  assert.deepEqual(published.runtime.names, [
    "CREDENTIAL_ENCRYPTION_KEY",
    "MEGURI_OPERATOR_TOKEN",
  ]);
  assert.equal(published.runtime.privateMode, true);
  assert.throws(() => readFileSync(published.runtime.path), { code: "ENOENT" });
  assert.equal(
    readdirSync(cwd).some((file) => file.startsWith("wrangler.deploy.")),
    false,
  );

  const redeployed = runDeploy();
  assert.equal(redeployed.status, 0, redeployed.stderr);
  const repeated = readCalls().slice(calls.length);
  assert.deepEqual(
    repeated.map(({ command }) => command),
    [
      "d1 list --json",
      "look up R2",
      ["d1", "migrations", "apply", "DB", "--remote"],
      ["deploy", "--secrets-file", repeated.at(-1).runtime.path],
    ],
  );

  const misconfigured = runDeploy({ MEGURI_PROJECTS: "[{}]" });
  assert.notEqual(misconfigured.status, 0);
  assert.match(misconfigured.stderr, /GitHub projects require/);
  assert.equal(readCalls().length, calls.length + repeated.length);
});

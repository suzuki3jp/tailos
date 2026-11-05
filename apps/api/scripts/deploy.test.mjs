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

test("applies migrations before deploy and limits the lifetime of runtime secrets", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "meguri-test-deploy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  copyFileSync(sourceConfig, join(cwd, "wrangler.jsonc"));
  const wrangler = join(cwd, "wrangler");
  const capture = join(cwd, "capture.ndjson");
  writeFileSync(
    wrangler,
    `#!/usr/bin/env node
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const config = JSON.parse(fs.readFileSync(args.at(-1), "utf8"));
    const secretsPath = args[args.indexOf("--secrets-file") + 1];
    const runtime = args.includes("--secrets-file") && {
      path: secretsPath,
      names: Object.keys(JSON.parse(fs.readFileSync(secretsPath, "utf8"))).sort(),
      privateMode: (fs.statSync(secretsPath).mode & 511) === 384,
    };
    fs.appendFileSync(process.env.MEGURI_TEST_CAPTURE, JSON.stringify({
      command: args[0], config, runtime, secretInEnvironment: Boolean(process.env.MEGURI_OPERATOR_TOKEN),
    }) + "\\n");
  `,
  );
  chmodSync(wrangler, 0o700);

  const id = "fcb7056f-e824-41f1-b447-b78d1408ab63";
  const env = {
    PATH: cwd + ":" + process.env.PATH,
    MEGURI_TEST_CAPTURE: capture,
    MEGURI_D1_DATABASE_ID: id,
    MEGURI_PROJECTS: "[]",
    MEGURI_OPERATOR_TOKEN: "test-operator",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };
  const result = spawnSync(process.execPath, [deploy], {
    cwd,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const [migration, published] = readFileSync(capture, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(migration.command, "d1");
  assert.equal(migration.config.d1_databases[0].database_id, id);
  assert.equal(published.command, "deploy");
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

  const misconfigured = spawnSync(process.execPath, [deploy], {
    cwd,
    env: { ...env, MEGURI_PROJECTS: "[{}]" },
    encoding: "utf8",
  });
  assert.notEqual(misconfigured.status, 0);
  assert.match(misconfigured.stderr, /GitHub projects require/);
  assert.equal(readFileSync(capture, "utf8").trim().split("\n").length, 2);
});

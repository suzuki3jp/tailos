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
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";

const deploy = fileURLToPath(new URL("./deploy.mjs", import.meta.url));
const provision = fileURLToPath(
  new URL("./provision-resources.mjs", import.meta.url),
);
const id = "fcb7056f-e824-41f1-b447-b78d1408ab63";
const sourceConfig = new URL("../wrangler.jsonc", import.meta.url);

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), "tailos-test-deploy-"));
  t.onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  copyFileSync(sourceConfig, join(cwd, "wrangler.jsonc"));
  const wrangler = join(cwd, "wrangler");
  const capture = join(cwd, "capture.ndjson");
  writeFileSync(
    wrangler,
    `#!/usr/bin/env node
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const record = (event) => fs.appendFileSync(process.env.TAILOS_TEST_CAPTURE, JSON.stringify(event) + "\\n");
    if (args[0] === "d1" && args[1] === "list") {
      record({ command: args.join(" ") });
      console.log(JSON.stringify(fs.existsSync("database") ? [{ name: "tailos", uuid: "${id}" }] : []));
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
      command: args.slice(0, args.indexOf("--config")), config, runtime, secretInEnvironment: Boolean(process.env.BETTER_AUTH_SECRET || process.env.TAILOS_GITHUB_OAUTH_CLIENT_SECRET || process.env.CREDENTIAL_ENCRYPTION_KEY),
    });
  `,
  );
  chmodSync(wrangler, 0o700);
  const pnpm = join(cwd, "pnpm");
  writeFileSync(
    pnpm,
    `#!/usr/bin/env node
    const fs = require("node:fs");
    fs.appendFileSync("capture.ndjson", JSON.stringify({
      command: process.argv.slice(2),
      secretInEnvironment: Object.keys(process.env).some((name) =>
        /^(CLOUDFLARE_API_TOKEN|BETTER_AUTH_SECRET|TAILOS_GITHUB_OAUTH_CLIENT_SECRET|CREDENTIAL_ENCRYPTION_KEY|TAILOS_GH_APP_PRIVATE_KEY|TAILOS_GH_WEBHOOK_SECRET)$/.test(name),
      ),
    }) + "\\n");
    if (fs.existsSync("fail-build")) process.exit(1);
    `,
  );
  chmodSync(pnpm, 0o700);

  const fetchStub = join(cwd, "fetch.mjs");
  writeFileSync(
    fetchStub,
    `import { appendFileSync, existsSync } from "node:fs";
    globalThis.fetch = async (url, { headers, body }) => {
      if (url === "https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/${id}/query") {
        if (headers.Authorization !== "Bearer test-token") throw new Error("Unexpected D1 authorization");
        const sql = JSON.parse(body).sql;
        appendFileSync(process.env.TAILOS_TEST_CAPTURE, JSON.stringify({ command: sql.includes("sqlite_master") ? "inspect Project table" : sql.includes("owner_id") ? "check Project owners" : "count Projects" }) + "\\n");
        if (existsSync("fail-project-lookup")) return Response.json({ success: false }, { status: 503 });
        const results = sql.includes("sqlite_master") ? existsSync("projects") || existsSync("deleted-projects") ? [{ name: "projects" }] : [] : [{ count: sql.includes("owner_id") ? existsSync("uninitialized-owner") ? 1 : 0 : existsSync("deleted-projects") ? 0 : 1 }];
        return Response.json({ success: true, result: [{ success: true, results }] });
      }
      if (url !== "https://api.cloudflare.com/client/v4/accounts/test-account/r2/buckets/tailos-run-artifacts") throw new Error("Unexpected R2 lookup URL");
      if (headers.Authorization !== "Bearer test-token") throw new Error("Unexpected R2 authorization");
      appendFileSync(process.env.TAILOS_TEST_CAPTURE, JSON.stringify({ command: "look up R2" }) + "\\n");
      return existsSync("bucket")
        ? Response.json({ success: true, result: { name: "tailos-run-artifacts" } })
        : Response.json({ errors: [{ code: 10006 }] }, { status: 404 });
    };`,
  );
  const env = {
    PATH: cwd + ":" + process.env.PATH,
    TAILOS_TEST_CAPTURE: capture,
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_API_TOKEN: "test-token",
  };
  const run = (script, overrides = {}) =>
    spawnSync(process.execPath, ["--import", fetchStub, script], {
      cwd,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
  const runDeploy = (overrides = {}) =>
    run(deploy, {
      TAILOS_D1_DATABASE_ID: id,
      TAILOS_PROJECTS: "[]",
      TAILOS_GITHUB_OAUTH_CLIENT_ID: "test-client",
      TAILOS_GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
      TAILOS_OPERATOR_GITHUB_ID: "123",
      BETTER_AUTH_SECRET: "test-only-47-characters-of-random-looking-value",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      ...overrides,
    });
  const readCalls = () =>
    readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);

  return { cwd, runDeploy, runProvision: () => run(provision), readCalls };
}

test("deploy stops before creation or migration when either resource is missing", (t) => {
  const { cwd, runDeploy, readCalls } = setup(t);

  const missingDatabase = runDeploy();
  expect(missingDatabase.status).not.toBe(0);
  expect(missingDatabase.stderr).toMatch(/D1 database "tailos" is missing/);
  expect(missingDatabase.stderr).toMatch(/Provision Cloudflare resources/);
  expect(readCalls().map(({ command }) => command)).toStrictEqual([
    "d1 list --json",
  ]);

  writeFileSync(join(cwd, "database"), "");
  const missingBucket = runDeploy();
  expect(missingBucket.status).not.toBe(0);
  expect(missingBucket.stderr).toMatch(
    /R2 bucket "tailos-run-artifacts" is missing/,
  );
  expect(missingBucket.stderr).toMatch(/Provision Cloudflare resources/);
  expect(
    readCalls()
      .slice(1)
      .map(({ command }) => command),
  ).toStrictEqual(["d1 list --json", "look up R2"]);
});

test("manual provisioning creates only missing resources and is safe to repeat", (t) => {
  const { runProvision, readCalls } = setup(t);

  const first = runProvision();
  expect(first.status, first.stderr).toBe(0);
  const second = runProvision();
  expect(second.status, second.stderr).toBe(0);
  expect(readCalls().map(({ command }) => command)).toStrictEqual([
    "d1 list --json",
    "d1 create tailos --location=apac --no-update-config",
    "d1 list --json",
    "look up R2",
    "r2 bucket create tailos-run-artifacts --no-update-config",
    "d1 list --json",
    "look up R2",
  ]);
});

test("deploy uses existing resources and removes temporary runtime secrets", (t) => {
  const { cwd, runDeploy, readCalls } = setup(t);
  writeFileSync(join(cwd, "database"), "");
  writeFileSync(join(cwd, "bucket"), "");
  const result = runDeploy();
  expect(result.status, result.stderr).toBe(0);
  const calls = readCalls();
  expect(calls.map(({ command }) => command)).toStrictEqual([
    "d1 list --json",
    "look up R2",
    "inspect Project table",
    ["--filter", "@tailos/runner", "run", "build"],
    ["d1", "migrations", "apply", "DB", "--remote"],
    [
      "d1",
      "execute",
      "DB",
      "--remote",
      "--command",
      "UPDATE projects SET owner_id = (SELECT user_id FROM auth_accounts WHERE provider_id = 'github' AND account_id = '123') WHERE owner_id IS NULL",
    ],
    "check Project owners",
    [
      "deploy",
      "--no-experimental-provision",
      "--secrets-file",
      calls.at(-1).runtime.path,
    ],
  ]);
  const build = calls.find((call) => call.command[0] === "--filter");
  const migration = calls.find((call) => call.command[1] === "migrations");
  const published = calls.at(-1);
  expect(build.secretInEnvironment).toBe(false);
  expect(migration.config.d1_databases[0].database_id).toBe(id);
  expect(published.config.d1_databases[0].database_id).toBe(id);
  expect(published.config.workers_dev).toBe(false);
  expect(published.config.preview_urls).toBe(false);
  expect(published.config.migrations[1]).toEqual({
    tag: "credentials-v1",
    new_sqlite_classes: ["CredentialBroker"],
  });
  expect(published.config.routes).toStrictEqual([
    { pattern: "api.tailos.app", custom_domain: true },
  ]);
  expect(published.config.vars.TAILOS_PUBLIC_ORIGIN).toBe(
    "https://api.tailos.app",
  );
  expect(published.config.vars.TAILOS_WEB_ORIGIN).toBe("https://tailos.app");
  expect(published.config.vars.TAILOS_OPERATOR_GITHUB_ID).toBe("123");
  expect(published.config.vars.TAILOS_GITHUB_OAUTH_CLIENT_ID).toBe(
    "test-client",
  );
  expect(published.config.vars.BETTER_AUTH_SECRET).toBe(undefined);
  expect(published.config.vars.TAILOS_GITHUB_OAUTH_CLIENT_SECRET).toBe(
    undefined,
  );
  expect(migration.secretInEnvironment).toBe(false);
  expect(migration.runtime).toBe(false);
  expect(published.secretInEnvironment).toBe(false);
  expect(published.runtime.names).toStrictEqual([
    "BETTER_AUTH_SECRET",
    "CREDENTIAL_ENCRYPTION_KEY",
    "TAILOS_GITHUB_OAUTH_CLIENT_SECRET",
  ]);
  expect(published.runtime.privateMode).toBe(true);
  expect(() => readFileSync(published.runtime.path)).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
  expect(
    readdirSync(cwd).some((file) => file.startsWith("wrangler.deploy.")),
  ).toBe(false);

  const missingLoginSecret = runDeploy({
    TAILOS_GITHUB_OAUTH_CLIENT_SECRET: "",
  });
  expect(missingLoginSecret.status).not.toBe(0);
  expect(missingLoginSecret.stderr).toMatch(/GitHub login requires/);

  expect(published.config.vars.PROJECTS).toBe(undefined);
});

test("deploy never migrates when the Runner cannot build", (t) => {
  const { cwd, runDeploy, readCalls } = setup(t);
  for (const marker of ["database", "bucket", "fail-build"]) {
    writeFileSync(join(cwd, marker), "");
  }
  const result = runDeploy();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "Runner bundle build failed before migration",
  );
  expect(readCalls().map(({ command }) => command)).toStrictEqual([
    "d1 list --json",
    "look up R2",
    "inspect Project table",
    ["--filter", "@tailos/runner", "run", "build"],
  ]);
});

test("deploy requires the verified D1 UUID before doing any writes", (t) => {
  const { cwd, runDeploy, readCalls } = setup(t);
  writeFileSync(join(cwd, "database"), "");
  for (const TAILOS_D1_DATABASE_ID of [
    "",
    "1d8f8a1c-84c9-4dad-819a-8d698b8bcb2e",
  ]) {
    const result = runDeploy({ TAILOS_D1_DATABASE_ID });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TAILOS_D1_DATABASE_ID must match");
  }
  expect(readCalls().map(({ command }) => command)).toEqual([
    "d1 list --json",
    "d1 list --json",
  ]);
});

test("deploy transfers the existing credential namespace and creates a fresh Runner", (t) => {
  const { cwd, runDeploy, readCalls } = setup(t);
  for (const marker of ["database", "bucket"])
    writeFileSync(join(cwd, marker), "");
  const result = runDeploy({ TAILOS_CREDENTIALS_FROM_WORKER: "meguri-api" });
  expect(result.status, result.stderr).toBe(0);
  expect(readCalls().at(-1).config.migrations).toEqual([
    { tag: "runner-v1", new_sqlite_classes: ["RunnerContainer"] },
    {
      tag: "credentials-v1",
      transferred_classes: [
        {
          from: "CredentialBroker",
          from_script: "meguri-api",
          to: "CredentialBroker",
        },
      ],
    },
  ]);
});

test("D1 projects retain deployment prerequisites and inspection failure prevents writes", (t) => {
  const { cwd, runDeploy, readCalls } = setup(t);
  for (const marker of ["database", "bucket", "projects"])
    writeFileSync(join(cwd, marker), "");
  const missing = runDeploy();
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("GitHub projects require");
  expect(readCalls().some((call) => Array.isArray(call.command))).toBe(false);
  const valid = runDeploy({
    TAILOS_GH_APP_ID: "100",
    TAILOS_GH_APP_PRIVATE_KEY: "test-key",
    TAILOS_GH_WEBHOOK_SECRET: "test-secret",
  });
  expect(valid.status, valid.stderr).toBe(0);
  const previous = readCalls().length;
  writeFileSync(join(cwd, "fail-project-lookup"), "");
  const failed = runDeploy();
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("Could not inspect D1 Project configuration");
  expect(
    readCalls()
      .slice(previous)
      .some((call) => Array.isArray(call.command)),
  ).toBe(false);
});

test("deploy refuses to publish while legacy projects have no initialized owner", (t) => {
  const { cwd, runDeploy, readCalls } = setup(t);
  for (const marker of ["database", "bucket", "uninitialized-owner"])
    writeFileSync(join(cwd, marker), "");
  const result = runDeploy();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("configured operator to log in");
  expect(readCalls().some((call) => call.command[0] === "deploy")).toBe(false);
  expect(
    readdirSync(cwd).some((file) => file.startsWith("wrangler.deploy.")),
  ).toBe(false);
});

test("deploy asks for GitHub login configuration when deleted legacy Projects remain without an operator", (t) => {
  const { cwd, runDeploy, readCalls } = setup(t);
  for (const marker of [
    "database",
    "bucket",
    "deleted-projects",
    "uninitialized-owner",
  ])
    writeFileSync(join(cwd, marker), "");
  const result = runDeploy({
    TAILOS_OPERATOR_GITHUB_ID: "",
    TAILOS_GITHUB_OAUTH_CLIENT_ID: "",
    TAILOS_GITHUB_OAUTH_CLIENT_SECRET: "",
    BETTER_AUTH_SECRET: "",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "GitHub login configuration, including TAILOS_OPERATOR_GITHUB_ID",
  );
  expect(result.stderr).not.toContain("configured operator to log in");
  expect(readCalls().some((call) => call.command[0] === "deploy")).toBe(false);
  expect(
    readdirSync(cwd).some((file) => file.startsWith("wrangler.deploy.")),
  ).toBe(false);
});

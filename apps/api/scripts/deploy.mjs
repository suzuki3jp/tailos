import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLoginConfig } from "./login-config.mjs";
import {
  findD1Database,
  hasR2Bucket,
  readResourceConfig,
  requireCloudflareCredentials,
  runWrangler,
} from "./provision.mjs";

const env = { ...process.env };
const login = readLoginConfig(env);
for (const name of Object.keys(login.secrets)) delete env[name];
requireCloudflareCredentials(env);
const { config, database, bucket } = readResourceConfig();
const wrangler = (args, capture) => runWrangler(args, env, capture);
const id = findD1Database(database.database_name, wrangler);
if (!id) {
  throw new Error(
    `D1 database "${database.database_name}" is missing. Verify the account and name, then run Provision Cloudflare resources if it needs to be created.`,
  );
}
if (!(await hasR2Bucket(bucket, env))) {
  throw new Error(
    `R2 bucket "${bucket.bucket_name}" is missing. Verify the account and name, then run Provision Cloudflare resources if it needs to be created.`,
  );
}
database.database_id = id;
config.vars = { ...config.vars, ...login.vars };

const path = `wrangler.deploy.${randomUUID()}.jsonc`;
const secretDir = mkdtempSync(join(tmpdir(), "meguri-deploy-"));
try {
  writeFileSync(path, JSON.stringify(config), { flag: "wx" });
  const deploy = ["deploy", "--no-experimental-provision"];
  if (Object.keys(login.secrets).length) {
    const secretPath = join(secretDir, "secrets.json");
    writeFileSync(secretPath, JSON.stringify(login.secrets), {
      flag: "wx",
      mode: 0o600,
    });
    deploy.push("--secrets-file", secretPath);
  }
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", path]);
  wrangler([...deploy, "--config", path]);
} finally {
  try {
    rmSync(path, { force: true });
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
}

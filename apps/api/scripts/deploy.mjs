import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeParse } from "valibot";
import { projectsSchema } from "../src/github/projects.ts";
import {
  findD1Database,
  hasR2Bucket,
  readResourceConfig,
  requireCloudflareCredentials,
  runWrangler,
} from "./provision.mjs";

const origin = "https://meguri.suzuki3.jp";
const domain = new URL(origin).hostname;
const runtimeSecrets = [
  "MEGURI_OPERATOR_TOKEN",
  "CREDENTIAL_ENCRYPTION_KEY",
  "MEGURI_GH_APP_PRIVATE_KEY",
  "MEGURI_GH_WEBHOOK_SECRET",
];

const env = { ...process.env };
const secrets = Object.fromEntries(
  runtimeSecrets
    .filter((name) => Boolean(env[name]))
    .map((name) => [name, env[name]]),
);
for (const name of runtimeSecrets) delete env[name];
requireCloudflareCredentials(env);

let projects;
try {
  projects = JSON.parse(env.MEGURI_PROJECTS || "[]");
} catch {
  throw new Error("MEGURI_PROJECTS must be a JSON array.");
}
if (!Array.isArray(projects))
  throw new Error("MEGURI_PROJECTS must be a JSON array.");
const appId = env.MEGURI_GH_APP_ID ?? "";
if (
  projects.length &&
  (!/^\d+$/.test(appId) ||
    Object.keys(secrets).length !== runtimeSecrets.length)
) {
  throw new Error(
    "GitHub projects require MEGURI_GH_APP_ID and all four runtime secrets.",
  );
}
if (
  Boolean(secrets.MEGURI_OPERATOR_TOKEN) !==
  Boolean(secrets.CREDENTIAL_ENCRYPTION_KEY)
) {
  throw new Error(
    "Set MEGURI_OPERATOR_TOKEN and CREDENTIAL_ENCRYPTION_KEY together.",
  );
}
if (
  secrets.CREDENTIAL_ENCRYPTION_KEY &&
  !/^[A-Za-z0-9+/]{43}=$/.test(secrets.CREDENTIAL_ENCRYPTION_KEY)
) {
  throw new Error(
    "CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
  );
}

const checkedProjects = safeParse(projectsSchema, projects);
if (!checkedProjects.success) {
  throw new Error(
    "MEGURI_PROJECTS does not match config/projects.example.json.",
  );
}

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
config.workers_dev = false;
config.routes = [{ pattern: domain, custom_domain: true }];
config.vars = {
  ...config.vars,
  MEGURI_PUBLIC_ORIGIN: origin,
  MEGURI_GH_APP_ID: appId,
  PROJECTS: JSON.stringify(checkedProjects.output),
};

const path = `wrangler.deploy.${randomUUID()}.jsonc`;
const secretDir = mkdtempSync(join(tmpdir(), "meguri-deploy-"));
try {
  writeFileSync(path, JSON.stringify(config), { flag: "wx" });
  const deploy = ["deploy", "--no-experimental-provision"];
  if (Object.keys(secrets).length) {
    const secretPath = join(secretDir, "secrets.json");
    writeFileSync(secretPath, JSON.stringify(secrets), {
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

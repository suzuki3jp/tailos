import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { safeParse } from "valibot";
import { projectsSchema } from "../src/github/projects.ts";
import { ensureD1Database, ensureR2Bucket, runWrangler } from "./provision.mjs";

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
if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
  throw new Error(
    "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to deploy.",
  );
}

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

const configErrors = [];
const config = parse(readFileSync("wrangler.jsonc", "utf8"), configErrors, {
  allowTrailingComma: true,
});
if (
  configErrors.length ||
  !config ||
  typeof config !== "object" ||
  !Array.isArray(config.d1_databases)
) {
  throw new Error("Invalid Wrangler configuration.");
}
const database = config.d1_databases.find(
  (binding) => binding.binding === "DB",
);
if (typeof database?.database_name !== "string" || !database.database_name) {
  throw new Error("The DB binding must specify a database_name.");
}
const bucket = config.r2_buckets?.find(
  (binding) => binding.binding === "RUN_ARTIFACTS",
);
if (typeof bucket?.bucket_name !== "string" || !bucket.bucket_name) {
  throw new Error("The RUN_ARTIFACTS binding must specify a bucket_name.");
}
const wrangler = (args, capture) => runWrangler(args, env, capture);
database.database_id = ensureD1Database(database.database_name, wrangler);
await ensureR2Bucket(bucket, env, wrangler);
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
  const deploy = ["deploy"];
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

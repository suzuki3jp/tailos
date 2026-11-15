import { spawnSync } from "node:child_process";
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

const origin = "https://api.tailos.app";
const webOrigin = "https://tailos.app";
const domain = new URL(origin).hostname;
const runtimeSecrets = [
  "CREDENTIAL_ENCRYPTION_KEY",
  "TAILOS_GH_APP_PRIVATE_KEY",
  "TAILOS_GH_WEBHOOK_SECRET",
];

const env = { ...process.env };
const login = readLoginConfig(env, origin);
const secrets = {
  ...login.secrets,
  ...Object.fromEntries(
    runtimeSecrets
      .filter((name) => Boolean(env[name]))
      .map((name) => [name, env[name]]),
  ),
};
for (const name of Object.keys(secrets)) delete env[name];
requireCloudflareCredentials(env);

const appId = env.TAILOS_GH_APP_ID ?? "";
if (
  secrets.CREDENTIAL_ENCRYPTION_KEY &&
  !/^[A-Za-z0-9+/]{43}=$/.test(secrets.CREDENTIAL_ENCRYPTION_KEY)
) {
  throw new Error(
    "CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
  );
}

const { config, database, bucket } = readResourceConfig();
const credentialSource = env.TAILOS_CREDENTIALS_FROM_WORKER;
if (credentialSource) {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(credentialSource) ||
    credentialSource === config.name ||
    !secrets.CREDENTIAL_ENCRYPTION_KEY
  ) {
    throw new Error(
      "Transferring CredentialBroker requires a source Worker and CREDENTIAL_ENCRYPTION_KEY.",
    );
  }
  config.migrations = config.migrations.map((migration) =>
    migration.tag === "credentials-v1"
      ? {
          tag: migration.tag,
          transferred_classes: [
            {
              from: "CredentialBroker",
              from_script: credentialSource,
              to: "CredentialBroker",
            },
          ],
        }
      : migration,
  );
}
const wrangler = (args, capture) => runWrangler(args, env, capture);
const id = findD1Database(database.database_name, wrangler);
if (!id) {
  throw new Error(
    `D1 database "${database.database_name}" is missing. Verify the account and name, then run Provision Cloudflare resources if it needs to be created.`,
  );
}
if (id !== env.TAILOS_D1_DATABASE_ID) {
  throw new Error(
    "TAILOS_D1_DATABASE_ID must match the verified Tailos D1 database UUID.",
  );
}
if (!(await hasR2Bucket(bucket, env))) {
  throw new Error(
    `R2 bucket "${bucket.bucket_name}" is missing. Verify the account and name, then run Provision Cloudflare resources if it needs to be created.`,
  );
}
// Keep the existing deployment prerequisites after moving their source of
// truth to D1. These are read-only queries, before build or migration writes.
async function projectRows(sql) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${id}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (
    !response.ok ||
    body?.success !== true ||
    body.result?.length !== 1 ||
    body.result[0]?.success !== true ||
    !Array.isArray(body.result[0].results)
  )
    throw new Error(
      "Could not inspect D1 Project configuration before deployment.",
    );
  return body.result[0].results;
}
const tables = await projectRows(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
);
if (tables.length) {
  const rows = await projectRows(
    "SELECT count(*) AS count FROM projects WHERE deleted_at IS NULL",
  );
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(rows[0].count) ||
    rows[0].count < 0
  )
    throw new Error("D1 returned an invalid Project count.");
  if (
    rows[0].count &&
    (!/^\d+$/.test(appId) ||
      !runtimeSecrets.every((name) => Boolean(secrets[name])) ||
      !login.vars.TAILOS_OPERATOR_GITHUB_ID)
  )
    throw new Error(
      "GitHub projects require GitHub login, TAILOS_GH_APP_ID, GitHub App secrets, and CREDENTIAL_ENCRYPTION_KEY.",
    );
}
database.database_id = id;
delete config.vars?.PROJECTS;
config.workers_dev = false;
config.preview_urls = false;
config.routes = [{ pattern: domain, custom_domain: true }];
config.vars = {
  ...config.vars,
  ...login.vars,
  TAILOS_PUBLIC_ORIGIN: origin,
  TAILOS_WEB_ORIGIN: webOrigin,
  TAILOS_GH_APP_ID: appId,
};

// Build before migrating. The build does not need any deployment credentials.
const build = spawnSync(
  "pnpm",
  ["--filter", "@tailos/runner", "run", "build"],
  {
    env: { PATH: env.PATH },
    stdio: "inherit",
  },
);
if (build.error || build.status !== 0) {
  throw new Error("Runner bundle build failed before migration.", {
    cause: build.error,
  });
}

const path = `wrangler.deploy.${randomUUID()}.jsonc`;
const secretDir = mkdtempSync(join(tmpdir(), "tailos-deploy-"));
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
  // Assign only legacy rows. Never transfer projects when the configured
  // operator changes. The numeric GitHub ID is validated by readLoginConfig.
  const githubId = login.vars.TAILOS_OPERATOR_GITHUB_ID;
  if (githubId) {
    wrangler([
      "d1",
      "execute",
      "DB",
      "--remote",
      "--command",
      `UPDATE projects SET owner_id = (SELECT user_id FROM auth_accounts WHERE provider_id = 'github' AND account_id = '${githubId}') WHERE owner_id IS NULL`,
      "--config",
      path,
    ]);
  }
  const unowned = await projectRows(
    "SELECT count(*) AS count FROM projects WHERE owner_id IS NULL",
  );
  if (unowned.length !== 1 || unowned[0].count !== 0)
    throw new Error(
      "Legacy Projects require the configured operator to log in before ownership can be assigned. Log in using the existing deployment and retry.",
    );
  wrangler([...deploy, "--config", path]);
} finally {
  try {
    rmSync(path, { force: true });
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
}

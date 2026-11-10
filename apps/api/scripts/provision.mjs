import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function requireCloudflareCredentials(env) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  }
}

export function readResourceConfig() {
  const errors = [];
  const config = parse(readFileSync("wrangler.jsonc", "utf8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length || !Array.isArray(config?.d1_databases)) {
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
  return { config, database, bucket };
}

export function runWrangler(args, env, capture = false) {
  const result = spawnSync("wrangler", args, {
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Wrangler ${args.slice(0, 2).join(" ")} failed (${result.signal ?? result.status})`,
    );
  }
  return result.stdout;
}

export function findD1Database(name, wrangler) {
  const databases = JSON.parse(wrangler(["d1", "list", "--json"], true));
  if (
    !Array.isArray(databases) ||
    databases.some((db) => typeof db?.name !== "string")
  ) {
    throw new Error("Wrangler returned an invalid D1 database list.");
  }
  const matches = databases.filter((db) => db.name === name);
  if (
    matches.length > 1 ||
    (matches.length === 1 &&
      (typeof matches[0].uuid !== "string" || !uuid.test(matches[0].uuid)))
  ) {
    throw new Error(
      `Could not resolve a unique D1 database UUID for "${name}".`,
    );
  }
  return matches[0]?.uuid;
}

export function ensureD1Database(name, wrangler) {
  const existing = findD1Database(name, wrangler);
  if (existing) return existing;

  try {
    wrangler(["d1", "create", name, "--location=apac", "--no-update-config"]);
  } catch (error) {
    const concurrent = findD1Database(name, wrangler);
    if (concurrent) return concurrent;
    throw error;
  }
  const created = findD1Database(name, wrangler);
  if (!created)
    throw new Error(
      `Wrangler created D1 database "${name}", but it was not found.`,
    );
  return created;
}

export async function hasR2Bucket(bucket, env) {
  const name = bucket.bucket_name;
  const account = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${encodeURIComponent(name)}`;
  const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  if (bucket.jurisdiction) headers["cf-r2-jurisdiction"] = bucket.jurisdiction;

  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.success === true && body.result?.name === name) {
    return true;
  }
  if (
    response.status === 404 &&
    Array.isArray(body?.errors) &&
    body.errors.some((error) => error?.code === 10006)
  ) {
    return false;
  }
  throw new Error(
    `Could not look up R2 bucket "${name}" (HTTP ${response.status}).`,
  );
}

export async function ensureR2Bucket(bucket, env, wrangler) {
  if (await hasR2Bucket(bucket, env)) return;

  const create = [
    "r2",
    "bucket",
    "create",
    bucket.bucket_name,
    "--no-update-config",
  ];
  if (bucket.jurisdiction) create.push("--jurisdiction", bucket.jurisdiction);
  try {
    wrangler(create);
  } catch (error) {
    if (!(await hasR2Bucket(bucket, env))) throw error;
  }
}

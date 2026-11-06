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
  return { config, database };
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
    wrangler(["d1", "create", name, "--no-update-config"]);
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

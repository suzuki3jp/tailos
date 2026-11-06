import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { ensureD1Database, ensureR2Bucket, runWrangler } from "./provision.mjs";

const env = process.env;
if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
  throw new Error(
    "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to deploy.",
  );
}

const configErrors = [];
const config = parse(readFileSync("wrangler.jsonc", "utf8"), configErrors, {
  allowTrailingComma: true,
});
if (configErrors.length || !Array.isArray(config?.d1_databases)) {
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

const path = `wrangler.deploy.${randomUUID()}.jsonc`;
writeFileSync(path, JSON.stringify(config), { flag: "wx" });
try {
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", path]);
  wrangler(["deploy", "--config", path]);
} finally {
  rmSync(path, { force: true });
}

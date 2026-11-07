import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import {
  findD1Database,
  hasR2Bucket,
  readResourceConfig,
  requireCloudflareCredentials,
  runWrangler,
} from "./provision.mjs";

const env = process.env;
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

const path = `wrangler.deploy.${randomUUID()}.jsonc`;
writeFileSync(path, JSON.stringify(config), { flag: "wx" });
try {
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", path]);
  wrangler(["deploy", "--no-experimental-provision", "--config", path]);
} finally {
  rmSync(path, { force: true });
}

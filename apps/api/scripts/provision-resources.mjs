import {
  ensureD1Database,
  ensureR2Bucket,
  readResourceConfig,
  requireCloudflareCredentials,
  runWrangler,
} from "./provision.mjs";

const env = process.env;
requireCloudflareCredentials(env);
const { database, bucket } = readResourceConfig();
const wrangler = (args, capture) => runWrangler(args, env, capture);
ensureD1Database(database.database_name, wrangler);
await ensureR2Bucket(bucket, env, wrangler);
process.stdout.write("Cloudflare resources are ready.\n");

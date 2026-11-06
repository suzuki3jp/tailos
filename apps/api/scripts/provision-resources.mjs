import {
  ensureD1Database,
  readResourceConfig,
  requireCloudflareCredentials,
  runWrangler,
} from "./provision.mjs";

const env = process.env;
requireCloudflareCredentials(env);
const { database } = readResourceConfig();
const wrangler = (args, capture) => runWrangler(args, env, capture);
ensureD1Database(database.database_name, wrangler);
process.stdout.write("Cloudflare resources are ready.\n");

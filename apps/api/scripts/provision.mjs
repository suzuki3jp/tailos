import { spawnSync } from "node:child_process";

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

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

export function ensureD1Database(name, wrangler) {
  const find = () => {
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
  };

  const existing = find();
  if (existing) return existing;

  try {
    wrangler(["d1", "create", name, "--no-update-config"]);
  } catch (error) {
    const concurrent = find();
    if (concurrent) return concurrent;
    throw error;
  }
  const created = find();
  if (!created)
    throw new Error(
      `Wrangler created D1 database "${name}", but it was not found.`,
    );
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(
      "::warning::Created an empty D1 database. Verify the deployment account and database name if this was unexpected.",
    );
  }
  return created;
}

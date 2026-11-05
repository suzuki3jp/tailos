import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

const id = process.env.MEGURI_D1_DATABASE_ID;
const placeholder = "00000000-0000-0000-0000-000000000000";
if (
  !id ||
  !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ||
  id === placeholder
) {
  throw new Error(
    "Set MEGURI_D1_DATABASE_ID to the production D1 database UUID.",
  );
}

const config = readFileSync("wrangler.jsonc", "utf8");
if (config.split(placeholder).length !== 2)
  throw new Error("Expected one local D1 placeholder.");

const path = `wrangler.deploy.${randomUUID()}.jsonc`;
writeFileSync(path, config.replace(placeholder, id), { flag: "wx" });
try {
  for (const command of [
    ["d1", "migrations", "apply", "DB", "--remote"],
    ["deploy"],
  ]) {
    const result = spawnSync("wrangler", [...command, "--config", path], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  unlinkSync(path);
}

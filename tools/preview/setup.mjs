import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare, previewDatabase } from "./cloudflare.mjs";
import { previewDomains, previewZone, workers } from "./config.mjs";

const domainsPath = "workers/domains";

function isPreviewOnly(domain) {
  return domain?.enabled === false && domain.previews_enabled === true;
}

async function domainChange(kind, hostname) {
  const query = new URLSearchParams({ hostname });
  const { result } = await cloudflare(`${domainsPath}?${query}`);
  if (!Array.isArray(result) || result.length > 1)
    throw new Error(`Unexpected Cloudflare domain list for ${hostname}`);
  const [current] = result;
  const service = workers[kind];
  if (
    result.length &&
    (current?.hostname !== hostname || current.service !== service)
  )
    throw new Error(
      `Cloudflare domain ${hostname} is not assigned to ${service}`,
    );
  if (isPreviewOnly(current)) return null;
  return {
    hostname,
    service,
    zone_name: previewZone,
    enabled: false,
    previews_enabled: true,
  };
}

function applyMigrations(database) {
  const temp = mkdtempSync(join(tmpdir(), "tailos-preview-db-"));
  const config = join(temp, "wrangler.json");
  try {
    const migrations_dir = fileURLToPath(
      new URL("../../apps/api/migrations", import.meta.url),
    );
    writeFileSync(
      config,
      JSON.stringify({ d1_databases: [{ ...database, migrations_dir }] }),
    );
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@tailos/api",
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        database.binding,
        "--remote",
        "--config",
        config,
      ],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function setupPreview(migrate = applyMigrations) {
  const database = await previewDatabase();
  const changes = await Promise.all(
    Object.entries(previewDomains).map(([kind, hostname]) =>
      domainChange(kind, hostname),
    ),
  );
  for (const json of changes.filter(Boolean)) {
    const { result } = await cloudflare(domainsPath, { method: "PUT", json });
    if (
      !isPreviewOnly(result) ||
      result.hostname !== json.hostname ||
      result.service !== json.service
    )
      throw new Error(
        `Cloudflare did not configure Preview-only routing for ${json.hostname}`,
      );
    process.stdout.write(`Configured ${json.hostname} on ${json.service}\n`);
  }
  migrate(database);
}

if (import.meta.main) await setupPreview();

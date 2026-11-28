import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare, previewDatabase } from "./cloudflare.mjs";
import { previewZone, webPreviewDomain, workers } from "./config.mjs";

const domainsPath = "workers/domains";

function isPreviewOnly(domain) {
  return domain?.enabled === false && domain.previews_enabled === true;
}

async function webDomainChange() {
  const hostname = webPreviewDomain;
  const query = new URLSearchParams({ hostname });
  const { result } = await cloudflare(`${domainsPath}?${query}`);
  if (!Array.isArray(result) || result.length > 1)
    throw new Error(`Unexpected Cloudflare domain list for ${hostname}`);
  const [current] = result;
  const service = workers.web;
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
  const apiSubdomainPath = `workers/scripts/${workers.api}/subdomain`;
  const [web, { result: api }] = await Promise.all([
    webDomainChange(),
    cloudflare(apiSubdomainPath),
  ]);
  if (web) {
    const { result } = await cloudflare(domainsPath, {
      method: "PUT",
      json: web,
    });
    if (
      !isPreviewOnly(result) ||
      result.hostname !== web.hostname ||
      result.service !== web.service
    )
      throw new Error(
        `Cloudflare did not configure Preview-only routing for ${web.hostname}`,
      );
    process.stdout.write(`Configured ${web.hostname} on ${web.service}\n`);
  }
  if (!isPreviewOnly(api)) {
    const { result } = await cloudflare(apiSubdomainPath, {
      method: "POST",
      json: { enabled: false, previews_enabled: true },
    });
    if (!isPreviewOnly(result))
      throw new Error(
        `Cloudflare did not configure workers.dev Preview URLs for ${workers.api}`,
      );
    process.stdout.write(
      `Enabled workers.dev Preview URLs for ${workers.api}\n`,
    );
  }
  migrate(database);
}

if (import.meta.main) await setupPreview();

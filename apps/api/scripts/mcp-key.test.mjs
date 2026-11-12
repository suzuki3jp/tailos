import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the local issuance command produces usable metadata without putting the plaintext key in server configuration", () => {
  const path = fileURLToPath(new URL("./mcp-key.mjs", import.meta.url));
  const owner = "306443bc-60f2-4ce4-b356-310abbe634fd";
  const start = Date.now();
  const run = spawnSync(process.execPath, [path, owner, "1"], {
    encoding: "utf8",
    env: {},
  });
  expect(run.status, run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  const config = JSON.parse(output.TAILOS_MCP_READ_KEY_CONFIG);
  expect(output.apiKey).toMatch(/^tailos_read_[A-Za-z0-9_-]{43}$/);
  expect(config.ownerId).toBe(owner);
  expect(config.sha256).toBe(
    createHash("sha256").update(output.apiKey).digest("hex"),
  );
  expect(output.TAILOS_MCP_READ_KEY_CONFIG).not.toContain(output.apiKey);
  expect(config.expiresAt).toBeGreaterThanOrEqual(start + 86_400_000);
  expect(config.expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000);
  for (const args of [[owner, "0"], [owner, "91"], ["not-a-user"]]) {
    const invalid = spawnSync(process.execPath, [path, ...args], {
      encoding: "utf8",
      env: {},
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toBe("");
  }
});

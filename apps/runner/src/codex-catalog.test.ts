import { readFile } from "node:fs/promises";
import { codexCatalogVersion } from "@tailos/core/models";
import { expect, test } from "vitest";

test("the model catalog matches the Codex CLI the Runner installs", async () => {
  const dockerfile = await readFile(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  const installed = /^ENV TAILOS_CODEX_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  // When this fails, update codexModels from the new version's bundled
  // catalog (codex-rs/models-manager/models.json) before changing the version.
  expect(installed).toBe(codexCatalogVersion);
});

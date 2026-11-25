import { readFile } from "node:fs/promises";
import { claudeCatalogVersion } from "@tailos/core/models";
import { expect, test } from "vitest";

test("the model catalog matches the Agent SDK the Runner installs", async () => {
  const dockerfile = await readFile(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  const installed = /^ENV TAILOS_CLAUDE_AGENT_SDK_VERSION=(\S+)$/m.exec(
    dockerfile,
  )?.[1];
  // When this fails, update claudeModels from the models that the new
  // version's Claude Code offers (supportedModels()) before changing it.
  expect(installed).toBe(claudeCatalogVersion);
});

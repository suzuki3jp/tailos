import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "./api-layers.mjs";

const rule = plugin.rules["api-layers"];
const filename = fileURLToPath(
  new URL("../apps/api/src/presentation/http/route.ts", import.meta.url),
);
const bindings = fileURLToPath(
  new URL("../apps/api/src/bindings.ts", import.meta.url),
);

function lintImport(specifier, sourceFile = filename, importKind = "value") {
  const messages = [];
  const visitor = rule.create({
    filename: sourceFile,
    report({ message }) {
      messages.push(message);
    },
  });
  visitor.ImportDeclaration({
    source: { value: specifier },
    specifiers: [],
    importKind,
  });
  return messages;
}

test("allows a presentation module to import application code by alias", () => {
  assert.deepEqual(lintImport("@/application/runs/artifacts.ts"), []);
});

test("rejects an aliased import from presentation into infrastructure", () => {
  const specifier = "@/infrastructure/d1/sessions.ts";
  assert.deepEqual(lintImport(specifier), [
    `API presentation cannot import infrastructure (${specifier}).`,
  ]);
});

test("rejects aliased test fixtures in production modules", () => {
  const specifier = "@/presentation/http/testing.ts";
  assert.deepEqual(lintImport(specifier), [
    `Production API modules cannot import test modules (${specifier}).`,
  ]);
});

test("allows bindings to reference application and platform types", () => {
  assert.deepEqual(
    lintImport("@/application/auth/device.ts", bindings, "type"),
    [],
  );
  assert.deepEqual(
    lintImport("@cloudflare/workers-types", bindings, "type"),
    [],
  );
});

test("rejects adapters as binding dependencies even when the import is type-only", () => {
  const specifier = "./infrastructure/cloudflare/runner-container.ts";
  assert.deepEqual(lintImport(specifier, bindings, "type"), [
    `API bindings cannot import infrastructure (${specifier}). Declare the platform contract in bindings.ts and have the adapter implement it.`,
  ]);
});

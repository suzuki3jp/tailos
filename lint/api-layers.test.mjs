import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "./api-layers.mjs";

const rule = plugin.rules["api-layers"];
const filename = fileURLToPath(
  new URL("../apps/api/src/presentation/http/route.ts", import.meta.url),
);

function lintImport(specifier) {
  const messages = [];
  const visitor = rule.create({
    filename,
    report({ message }) {
      messages.push(message);
    },
  });
  visitor.ImportDeclaration({ source: { value: specifier }, specifiers: [] });
  return messages;
}

test("allows a presentation module to import application code by alias", () => {
  assert.deepEqual(lintImport("#api/application/runs/artifacts.ts"), []);
});

test("rejects an aliased import from presentation into infrastructure", () => {
  const specifier = "#api/infrastructure/d1/sessions.ts";
  assert.deepEqual(lintImport(specifier), [
    `API presentation cannot import infrastructure (${specifier}).`,
  ]);
});

test("rejects aliased test fixtures in production modules", () => {
  const specifier = "#api/presentation/http/testing.ts";
  assert.deepEqual(lintImport(specifier), [
    `Production API modules cannot import test modules (${specifier}).`,
  ]);
});

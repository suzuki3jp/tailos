import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  buildInternalGraph,
  findImportCycle,
  moduleImports,
} from "./internal-dependencies.mjs";

test("includes types, re-exports and lazy imports in the internal graph", () => {
  assert.deepEqual(
    moduleImports(
      "page.tsx",
      [
        'import type { View } from "./view";',
        'import { type Detail } from "./detail";',
        'export type { Model } from "./model";',
        'export { Button } from "./button";',
        'type Query = import("./query").Query;',
        "const load = () => import(`./loader`);",
        'const data = require("./data.cjs");',
        "const element = <div />;",
      ].join("\n"),
    ),
    [
      { specifier: "./view", typeOnly: true },
      { specifier: "./detail", typeOnly: true },
      { specifier: "./model", typeOnly: true },
      { specifier: "./button", typeOnly: false },
      { specifier: "./query", typeOnly: true },
      { specifier: "./loader", typeOnly: false },
      { specifier: "./data.cjs", typeOnly: false },
    ],
  );
});

test("reports the path through a cycle with a type-only edge", () => {
  const graph = new Map([
    ["route.ts", new Map([["bindings.ts", true]])],
    ["bindings.ts", new Map([["adapter.ts", true]])],
    ["adapter.ts", new Map([["bindings.ts", false]])],
  ]);
  assert.deepEqual(findImportCycle(graph), [
    "bindings.ts",
    "adapter.ts",
    "bindings.ts",
  ]);
});

test("production internal imports are acyclic", () => {
  const cycle = findImportCycle(buildInternalGraph());
  assert.ok(
    !cycle,
    `Internal dependency cycle: ${cycle?.join(" -> ")}. Move the shared contract to a module both can depend on, or remove the reverse import.`,
  );
});

test("cross-workspace imports require a dependency declaration and a public export", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tailos-dependencies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const write = (file, content) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  write(
    "apps/api/package.json",
    JSON.stringify({
      name: "@tailos/api",
      exports: { "./browser": { types: "./src/http.ts" } },
    }),
  );
  write("apps/api/src/http.ts", "export type Api = { status: number };");
  write(
    "apps/web/src/client.ts",
    'import type { Api } from "@tailos/api/browser";',
  );
  write("apps/web/package.json", JSON.stringify({ name: "@tailos/web" }));
  assert.throws(
    () => buildInternalGraph(root),
    /declare workspace dependency @tailos\/api/,
  );

  write(
    "apps/web/package.json",
    JSON.stringify({
      name: "@tailos/web",
      devDependencies: { "@tailos/api": "workspace:*" },
    }),
  );
  assert.deepEqual(
    buildInternalGraph(root).get("apps/web/src/client.ts"),
    new Map([["apps/api/src/http.ts", true]]),
  );
  write(
    "apps/web/src/client.ts",
    'import type { Api } from "@tailos/api/src/http.ts";',
  );
  assert.throws(() => buildInternalGraph(root), /is not a workspace export/);
  write(
    "apps/web/src/client.ts",
    'import type { Api } from "../../api/src/http.ts";',
  );
  assert.throws(() => buildInternalGraph(root), /reaches into @tailos\/api/);
});

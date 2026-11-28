import assert from "node:assert/strict";
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("../", import.meta.url));
const oxlint = join(repository, "node_modules/oxlint/bin/oxlint");
const steiger = join(repository, "node_modules/steiger/dist/cli.mjs");
const boundaryRule = new URL("./web-boundaries.mjs", import.meta.url).href;

async function fixture(t, files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tailos-fsd-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

function run(cli, cwd, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { status: result.status, output: result.stdout + result.stderr };
}

async function boundaryFixture(t, cases) {
  const root = await fixture(t, cases);
  const src = join(root, "src");
  const plugin = pathToFileURL(join(root, "plugin.mjs")).href;
  await writeFile(
    join(root, "plugin.mjs"),
    `import { createWebBoundaryRule } from ${JSON.stringify(boundaryRule)};
export default { meta: { name: "tailos-web" }, rules: { boundaries: createWebBoundaryRule(${JSON.stringify(src)}) } };`,
  );
  await writeFile(
    join(root, ".oxlintrc.json"),
    JSON.stringify({
      jsPlugins: [fileURLToPath(plugin)],
      rules: { "tailos-web/boundaries": "error" },
    }),
  );
  return run(oxlint, root, [
    "--threads=1",
    "--config",
    ".oxlintrc.json",
    "src",
  ]);
}

test("Oxlint allows public adapters, framework composition and API types", async (t) => {
  const result = await boundaryFixture(t, {
    "src/app/page.tsx": 'export { Home as default } from "@/_pages/home";',
    "src/app/other/page.tsx":
      'export { Home as default } from "../../_pages/home/index.ts";',
    "src/app/layout.tsx":
      'import { Providers } from "./providers"; export { Providers };',
    "src/app/providers.tsx": 'export const Providers = "providers";',
    "src/app/page.test.tsx": 'import Home from "./page"; export { Home };',
    "src/app/other/layout.spec.tsx":
      'import Layout from "./layout.tsx"; export { Layout };',
    "src/app/widget.ts": 'export { Panel } from "@/widgets/panel";',
    "src/worker/index.ts":
      'import { origin } from "@/shared/config"; export { origin };',
    "src/worker/index.test.ts":
      'import worker from "./index"; export { worker };',
    "src/shared/api/client.ts":
      'import { type BrowserApi } from "@tailos/api/browser"; export type Api = BrowserApi;',
    "src/shared/api/types.ts":
      'export type { BrowserApi } from "@tailos/api/browser";',
    "src/shared/api/inline-types.ts":
      'export { type BrowserApi } from "@tailos/api/browser";',
    "src/shared/api/import-type.ts":
      'export type Api = import("@tailos/api/browser").BrowserApi;',
    "src/_pages/home/ui/home.ts":
      'import { text } from "./text"; export { text };',
  });
  assert.equal(result.status, 0, result.output);
});

test("Oxlint rejects adapter bypasses and backend implementation imports", async (t) => {
  const cases = {
    "src/_pages/home/ui/from-app.ts":
      'import { Providers } from "@/app/providers"; export { Providers };',
    "src/shared/api/from-worker.ts":
      'export { default } from "../../worker/index";',
    "src/app/deep/page.tsx":
      'export { Home as default } from "@/_pages/home/ui/home";',
    "src/app/relative/page.tsx":
      'export { Home as default } from "../../_pages/home/ui/home";',
    "src/app/other/page.tsx": 'export { default } from "../page";',
    "src/app/other/page.test.tsx": 'export { default } from "../page";',
    "src/app/layout.test.tsx": 'export { default } from "./page";',
    "src/app/config.ts": 'export { origin } from "@/shared/config/origin";',
    "src/app/widget.ts": 'export { Panel } from "@/widgets/panel/ui/panel";',
    "src/worker/screen.ts": 'export { Home } from "@/_pages/home";',
    "src/worker/client.ts": 'export { api } from "@/shared/api";',
    "src/shared/api/value.ts":
      'import { BrowserApi } from "@tailos/api/browser"; export { BrowserApi };',
    "src/shared/api/private.ts":
      'export type { Env } from "@tailos/api/src/bindings";',
    "src/shared/api/relative.ts":
      'export type { Env } from "../../../../api/src/bindings";',
    "src/shared/api/runner.ts": 'export { run } from "@tailos/runner";',
    "src/_pages/home/api/dynamic.ts":
      'export const load = () => import("@/app/providers");',
    "src/_pages/home/api/computed.ts":
      "export const load = (path: string) => import(path);",
    "src/_pages/home/api/require.ts":
      'export const load = require("@/app/providers");',
    "src/_pages/home/api/import-type.ts":
      'export type Provider = import("@/app/providers").Provider;',
    "src/_pages/home/api/import-equals.ts":
      'import Provider = require("@/app/providers"); export { Provider };',
    "src/_pages/home/api/test-import.ts": 'export { data } from "./data.test";',
  };
  const result = await boundaryFixture(t, cases);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /tailos-web\(boundaries\)/);
  for (const path of Object.keys(cases)) {
    assert.ok(
      result.output.includes(path),
      `Missing boundary diagnostic for ${path}:\n${result.output}`,
    );
  }
});

test("Oxlint only allows a colocated route test to import its own subject", async (t) => {
  const valid = await boundaryFixture(t, {
    "src/app/page.test.tsx": 'import Page from "./page"; export { Page };',
    "src/app/account/layout.spec.tsx":
      'import Layout from "./layout.tsx"; export { Layout };',
  });
  assert.equal(valid.status, 0, valid.output);

  const cases = {
    "src/app/other/page.test.tsx":
      'import Page from "../page"; export { Page };',
    "src/app/page.spec.tsx":
      'import Layout from "./layout"; export { Layout };',
    "src/app/example.tsx": 'import Page from "./page"; export { Page };',
  };
  const invalid = await boundaryFixture(t, cases);
  assert.equal(invalid.status, 1, invalid.output);
  for (const path of Object.keys(cases)) {
    assert.ok(invalid.output.includes(path), invalid.output);
  }
});

const validFsd = {
  "package.json": '{"type":"module"}',
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      moduleResolution: "bundler",
      paths: { "@/*": ["./src/*"] },
    },
  }),
  "src/app/page.tsx": 'export { Home as default } from "@/_pages/home";',
  "src/worker/index.ts": "export const worker = true;",
  "src/_pages/home/index.ts": 'export { Home } from "./ui/home";',
  "src/_pages/home/ui/home.ts":
    'import { Panel } from "@/widgets/panel"; export const Home = Panel;',
  "src/widgets/panel/index.ts": 'export { Panel } from "./ui/panel";',
  "src/widgets/panel/ui/panel.ts":
    'import { action } from "@/features/action"; import { Button } from "@/shared/ui/button"; export const Panel = () => Button(action());',
  "src/_pages/other/index.ts": 'export { Other } from "./ui/other";',
  "src/_pages/other/ui/other.ts": 'export const Other = "other";',
  "src/features/action/index.ts": 'export { action } from "./model/action";',
  "src/features/action/model/action.ts":
    'import type { Item } from "@/entities/item"; export const action = (): Item => ({ id: "item" });',
  "src/entities/item/index.ts": 'export type { Item } from "./model/item";',
  "src/entities/item/model/item.ts": "export type Item = { id: string };",
  "src/shared/ui/button/index.ts": 'export { Button } from "./button";',
  "src/shared/ui/button/button.ts":
    "export const Button = (value: unknown) => value;",
};

async function fsdFixture(t, changes = {}) {
  const files = { ...validFsd, ...changes };
  for (const key of Object.keys(files))
    if (files[key] === null) delete files[key];
  const root = await fixture(t, files);
  await symlink(
    join(repository, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  await writeFile(
    join(root, "steiger.config.ts"),
    await readFile(join(repository, "apps/web/steiger.config.ts"), "utf8"),
  );
  return run(steiger, root, ["./src"]);
}

test("Steiger accepts _pages, public Shared modules and the adapter exceptions", async (t) => {
  const result = await fsdFixture(t);
  assert.equal(result.status, 0, result.output);
});

for (const [name, changes, rule] of [
  [
    "widgets importing pages",
    {
      "src/widgets/panel/ui/panel.ts":
        'export { Home as Panel } from "@/_pages/home";',
    },
    "fsd/forbidden-imports",
  ],
  [
    "features importing widgets",
    {
      "src/features/action/model/action.ts":
        'export { Panel as action } from "@/widgets/panel";',
    },
    "fsd/forbidden-imports",
  ],
  [
    "widget deep imports",
    {
      "src/_pages/home/ui/home.ts":
        'export { Panel as Home } from "@/widgets/panel/ui/panel";',
    },
    "fsd/no-public-api-sidestep",
  ],
  [
    "higher-layer type imports through _pages",
    {
      "src/entities/item/model/item.ts":
        'import type { Home } from "@/_pages/home"; export type Item = Home;',
    },
    "fsd/forbidden-imports",
  ],
  [
    "cross-imports between page slices",
    {
      "src/_pages/home/ui/home.ts":
        'import { Other } from "@/_pages/other"; export { Other as Home };',
    },
    "fsd/forbidden-imports",
  ],
  [
    "relative cross-imports",
    {
      "src/_pages/home/ui/home.ts":
        'export { Other as Home } from "../../other";',
    },
    "fsd/forbidden-imports",
  ],
  [
    "static dynamic imports of higher layers",
    {
      "src/entities/item/model/item.ts":
        'export const load = () => import("@/_pages/home");',
    },
    "fsd/forbidden-imports",
  ],
  [
    "slice deep imports",
    {
      "src/_pages/home/ui/home.ts":
        'import { action } from "@/features/action/model/action"; export const Home = action;',
    },
    "fsd/no-public-api-sidestep",
  ],
  [
    "Shared deep imports",
    {
      "src/_pages/home/ui/home.ts":
        'import { Button } from "@/shared/ui/button/button"; export const Home = Button;',
    },
    "fsd/no-public-api-sidestep",
  ],
  [
    "missing slice public APIs",
    {
      "src/_pages/home/index.ts": null,
    },
    "fsd/public-api",
  ],
  [
    "missing Shared module public APIs",
    {
      "src/shared/ui/button/index.ts": null,
    },
    "fsd/public-api",
  ],
  [
    "wildcard exports",
    {
      "src/_pages/home/index.ts": 'export * from "./ui/home";',
    },
    "fsd/no-wildcard-exports",
  ],
  [
    "same-slice alias imports",
    {
      "src/_pages/home/index.ts":
        'export { Home } from "@/_pages/home/ui/home";',
    },
    "fsd/import-locality",
  ],
  [
    "layer barrels",
    {
      "src/_pages/index.ts": 'export { Home } from "./home";',
    },
    "fsd/no-layer-public-api",
  ],
]) {
  test(`Steiger rejects ${name}`, async (t) => {
    const result = await fsdFixture(t, changes);
    assert.equal(result.status, 1, result.output);
    assert.ok(result.output.includes(rule), result.output);
  });
}

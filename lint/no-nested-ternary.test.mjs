import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const config = fileURLToPath(new URL("../.oxlintrc.json", import.meta.url));
const oxlint = fileURLToPath(
  new URL("../node_modules/oxlint/bin/oxlint", import.meta.url),
);

async function lint(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "tailos-ternary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "fixture.tsx"), source);
  const result = spawnSync(
    process.execPath,
    [
      oxlint,
      "--threads=1",
      "--config",
      config,
      "--format",
      "json",
      "fixture.tsx",
    ],
    { cwd: directory, encoding: "utf8", timeout: 20_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return {
    status: result.status,
    diagnostics: JSON.parse(result.stdout).diagnostics,
  };
}

test("rejects a nested ternary in the test or either branch", async (t) => {
  const result = await lint(
    t,
    `
export const inTest = (true ? 1 : 2) ? "yes" : "no";
export const inConsequent = true ? (false ? 1 : 2) : 3;
export const inAlternate = true ? 1 : false ? 2 : 3;
`,
  );
  assert.equal(result.status, 1);
  const violations = result.diagnostics.filter(
    ({ code }) => code === "tailos-style(no-nested-ternary)",
  );
  assert.deepEqual(
    violations.map(({ labels }) => labels[0].span.line),
    [2, 3, 4],
  );
  for (const { message } of violations) {
    assert.match(message, /named function with early returns/);
    assert.match(message, /object mapping/);
    assert.match(message, /satisfies Record<ExpectedKeys, Value>/);
    assert.match(message, /switch with returning cases/);
    assert.match(message, /Preserve branch evaluation and type narrowing/);
    assert.match(message, /let with if\/else assignments only when/);
  }
});

test("allows standalone ternaries and the recommended replacements", async (t) => {
  const result = await lint(
    t,
    `
export function label(active: boolean) {
  const labels = { active: "active", idle: "idle" };
  return labels[active ? "active" : "idle"];
}
export const pair = (a: boolean, b: boolean) => [a ? 1 : 2, b ? 3 : 4];
type State = "pending" | "succeeded" | "failed";
const labels = {
  pending: "Waiting", succeeded: "Done", failed: "Failed",
} satisfies Record<State, string>;
export function stateLabel(state: State) { return labels[state]; }
export function expiry(now: number, expiresAt: number) {
  if (now >= expiresAt) return "passed";
  if (now >= expiresAt - 30) return "soon";
  return "valid";
}
export function renderState(state: State) {
  switch (state) {
    case "pending": return <p>Waiting</p>;
    case "succeeded": return <p>Done</p>;
    case "failed": return <p>Failed</p>;
  }
}
`,
  );
  assert.deepEqual(result, { status: 0, diagnostics: [] });
});

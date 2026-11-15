import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  changedPaths,
  normalize,
  readRecords,
  resolveKey,
  search,
  show,
  validateRecords,
} from "./lib.mjs";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tailos-pdr-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs/pdr/records"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".cache/pdr/\n");
  return root;
}

function put(root, id, overrides = {}, body = {}) {
  const metadata = {
    schema: 1,
    id,
    key: `fixture.${id.toLowerCase()}`,
    status: "accepted",
    date: "2026-11-13",
    areas: ["fixture"],
    keywords: [],
    paths: [],
    supersedes: [],
    decided_by: "fixture human",
    ...overrides,
  };
  const content =
    `---\n${Object.entries(metadata)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n")}\n---\n\n` +
    `# ${body.title ?? "返答の扱いを決める"}\n\n## 決定\n\n${body.decision ?? "長い返答は要約する。"}\n\n` +
    `## 理由\n\n${body.rationale ?? "質問を失わないため。"}\n\n## 範囲と例外\n\n${body.scope ?? "対象の返答だけに適用する。"}\n`;
  const path = join(root, `docs/pdr/records/${id}.md`);
  writeFileSync(path, content);
  return path;
}

function run(root, ...args) {
  return spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", cli, "--root", root, ...args],
    { encoding: "utf8" },
  );
}

test("accepts self-contained records without conversation files or approval links", (t) => {
  const root = fixture(t);
  put(root, "PDR-1");
  const records = readRecords(root);
  assert.equal(records[0].status, "accepted");
  assert.deepEqual(Object.keys(records[0].sections), [
    "decision",
    "rationale",
    "scope",
  ]);
  assert.equal(existsSync(join(root, "docs/pdr/sources")), false);
  const detail = show(records, "PDR-1");
  assert.equal(detail.decided_by, "fixture human");
  assert.equal("approval" in detail, false);
  assert.match(detail.record_hash, /^[a-f0-9]{64}$/);
  assert.equal(
    search(root, records, { query: "返答" }).results[0].record_hash,
    detail.record_hash,
  );
  for (const field of ["sources", "approval"]) {
    put(root, "PDR-1", {
      [field]: field === "sources" ? [] : "https://example.com/chat",
    });
    assert.throws(
      () => readRecords(root),
      new RegExp(`unknown field ${field}`),
    );
  }
  put(root, "PDR-1", {}, { rationale: "" });
  assert.throws(() => readRecords(root), /理由.*required/);
});

test("real questions find this session's decisions and keep unknown rationale non-authoritative", () => {
  const records = readRecords(repository);
  for (const [query, id] of [
    ["長文 要約", "PDR-20261113-003"],
    ["8,000 根拠", "PDR-20261113-004"],
    ["通知 障害 Run", "PDR-20261113-006"],
    ["@tailos plan inbox", "PDR-20261113-012"],
    ["kind", "PDR-20261113-007"],
    ["未適用 migration", "PDR-20261113-008"],
    ["GIF 背景", "PDR-20261113-009"],
    ["人間 承認", "PDR-20261113-002"],
    ["チャットを保存しない", "PDR-20261113-011"],
    ["返答が長いとどうなる", "PDR-20261113-003"],
    ["なぜ8000文字なのか", "PDR-20261113-004"],
    ["通知に失敗するとRunも失敗するか", "PDR-20261113-006"],
  ])
    assert.ok(
      search(repository, records, { query }).results.some((r) => r.id === id),
      query,
    );
  assert.equal(
    resolveKey(records, "agent.reply.overflow").current.status,
    "accepted",
  );
  assert.equal(
    resolveKey(records, "agent.reply.limit-value").state,
    "no_accepted_decision",
  );
  const unknown = search(repository, records, {
    query: "8000 根拠",
  }).results.find((r) => r.id === "PDR-20261113-004");
  assert.equal(unknown.authoritative, false);
  for (const id of [
    "PDR-20261113-001",
    "PDR-20261113-002",
    "PDR-20261113-003",
    "PDR-20261113-006",
    "PDR-20261113-007",
    "PDR-20261113-008",
    "PDR-20261113-009",
    "PDR-20261113-011",
  ])
    assert.equal(records.find((r) => r.id === id)?.status, "accepted", id);
});

test("normalizes numeric spellings and finds short Japanese terms", (t) => {
  const root = fixture(t);
  put(root, "PDR-1", { keywords: ["8000"] }, { title: "色を合わせる" });
  const records = readRecords(root);
  for (const query of ["8000", "8,000", "8_000", "8k", "８，０００", "色"])
    assert.equal(
      search(root, records, { query }).results[0].id,
      "PDR-1",
      query,
    );
  assert.equal(normalize("8_000 8,000 8k"), "8000 8000 8000");
});

test("keeps Markdown examples inside a decision rather than parsing them as sections", (t) => {
  const root = fixture(t);
  const decision =
    "Markdown の例。\n\n```md\n## Example heading\n```\n\n本文の続き。";
  put(root, "PDR-1", {}, { decision });
  assert.equal(readRecords(root)[0].sections.decision, decision);
});

test("path hints add candidates without excluding cross-cutting policies", (t) => {
  const root = fixture(t);
  put(root, "PDR-1", { paths: ["apps/runner/**"] });
  put(
    root,
    "PDR-2",
    { paths: ["elsewhere/*"] },
    { decision: "失敗時の通知方針" },
  );
  const result = search(root, readRecords(root), {
    query: "通知",
    paths: ["apps/runner/src/agent.ts"],
  });
  assert.deepEqual(
    new Set(result.results.map((r) => r.id)),
    new Set(["PDR-1", "PDR-2"]),
  );
});

test("path globstars match zero or more directories without broadening single stars", (t) => {
  const root = fixture(t);
  for (const [pattern, matches, misses] of [
    ["apps/**/*.ts", ["apps/x.ts", "apps/a/b/x.ts"], ["x.ts", "apps/x.js"]],
    ["a/**/b.ts", ["a/b.ts", "a/x/y/b.ts"], ["ab.ts", "a/x/c.ts"]],
    ["**/x.ts", ["x.ts", "a/b/x.ts"], ["ax.ts", "a/x.tsx"]],
    ["docs/pdr/**", ["docs/pdr/x.md", "docs/pdr/records/x.md"], ["docs/x.md"]],
    ["apps/*.ts", ["apps/x.ts"], ["apps/a/x.ts", "apps/xXts"]],
    ["a/**/b/**/c.ts", ["a/b/c.ts", "a/x/b/y/z/c.ts"], ["a/b/x.ts"]],
  ]) {
    put(root, "PDR-1", { paths: [pattern] });
    const records = readRecords(root);
    for (const path of matches)
      assert.equal(
        search(root, records, { paths: [path] }).total,
        1,
        `${pattern}: ${path}`,
      );
    for (const path of misses)
      assert.equal(
        search(root, records, { paths: [path] }).total,
        0,
        `${pattern}: ${path}`,
      );
  }
});

test("routes historical matches to current decisions and keeps drafts visible", (t) => {
  const root = fixture(t);
  put(
    root,
    "PDR-1",
    { key: "reply.policy", status: "superseded" },
    { decision: "旧式の切り捨て" },
  );
  put(
    root,
    "PDR-2",
    { key: "reply.policy", supersedes: ["PDR-1"] },
    { decision: "要約を要求する" },
  );
  put(root, "PDR-3", {
    key: "reply.policy",
    status: "proposed",
    supersedes: ["PDR-2"],
  });
  const records = readRecords(root);
  const current = search(root, records, { query: "旧式" }).results[0];
  assert.equal(current.id, "PDR-2");
  assert.ok(current.matched_on.includes("successor-of:PDR-1"));
  assert.equal(
    search(root, records, { query: "旧式", history: true }).results[0]
      .authoritative,
    false,
  );
  const resolved = resolveKey(records, "reply.policy");
  assert.equal(resolved.current.id, "PDR-2");
  assert.equal(resolved.attention[0].id, "PDR-3");
  assert.equal(show(records, "PDR-1").successors[0].id, "PDR-2");
});

test("rejects conflicting accepted decisions, missing decision maker and invalid lifecycle graphs", (t) => {
  const root = fixture(t);
  put(root, "PDR-1", { key: "reply.policy" });
  put(root, "PDR-2", { key: "reply.policy" });
  assert.throws(() => readRecords(root), /Multiple accepted/);
  rmSync(join(root, "docs/pdr/records/PDR-2.md"));
  put(root, "PDR-1", { decided_by: "" });
  assert.throws(() => readRecords(root), /decided_by/);
  put(root, "PDR-1", {
    key: "reply.policy",
    status: "superseded",
    supersedes: ["PDR-2"],
  });
  put(root, "PDR-2", {
    key: "reply.policy",
    status: "superseded",
    supersedes: ["PDR-1"],
  });
  assert.throws(() => readRecords(root), /cycle/);
  put(root, "PDR-1", { key: "reply.policy", status: "superseded" });
  put(root, "PDR-2", {
    key: "reply.policy",
    status: "accepted",
    supersedes: ["missing"],
  });
  assert.throws(() => readRecords(root), /supersedes/);
});

test("rejects duplicate IDs and broken or escaping optional Markdown links", (t) => {
  const root = fixture(t);
  put(root, "PDR-1");
  const records = readRecords(root);
  assert.throws(
    () => validateRecords(root, [records[0], records[0]]),
    /Duplicate/,
  );
  for (const link of ["#missing", "missing.md", "../../../../outside.md"]) {
    put(root, "PDR-1", {}, { rationale: `理由の説明。[補助資料](${link})` });
    assert.throws(() => readRecords(root), /missing|escapes/);
  }
  put(
    root,
    "PDR-1",
    {},
    { rationale: "理由の説明。[補助資料](javascript:alert)" },
  );
  assert.throws(() => readRecords(root), /unsupported link/);
  rmSync(join(root, "docs/pdr/records/PDR-1.md"));
  symlinkSync(
    join(root, ".gitignore"),
    join(root, "docs/pdr/records/PDR-link.md"),
  );
  assert.throws(() => readRecords(root), /symlinks/);
});

test("rebuilds the cache after edits, additions, deletions and corruption without git HEAD", (t) => {
  const root = fixture(t);
  const first = put(root, "PDR-1", {}, { decision: "最初の語句" });
  const before = search(root, readRecords(root), { query: "最初" });
  put(root, "PDR-1", {}, { decision: "書き換えた語句" });
  const edited = search(root, readRecords(root), { query: "書き換え" });
  assert.notEqual(edited.fingerprint, before.fingerprint);
  assert.equal(search(root, readRecords(root), { query: "最初" }).total, 0);
  put(root, "PDR-2", {}, { decision: "追加された語句" });
  assert.equal(
    search(root, readRecords(root), { query: "追加" }).results[0].id,
    "PDR-2",
  );
  rmSync(first);
  assert.equal(search(root, readRecords(root), { query: "書き換え" }).total, 0);
  writeFileSync(join(root, ".cache/pdr/index.sqlite"), "corrupt");
  assert.equal(
    search(root, readRecords(root), { query: "追加" }).results[0].id,
    "PDR-2",
  );
});

test("pages search results and complete sections without hiding omitted content", (t) => {
  const root = fixture(t);
  for (let i = 0; i < 7; i++)
    put(
      root,
      `PDR-${i}`,
      {},
      { decision: "長い本文の要約方針を記録する。\n\nこの文も保存する。" },
    );
  const records = readRecords(root);
  const first = search(root, records, { query: "本文", limit: 2, chars: 5 });
  assert.equal(first.total, 7);
  assert.equal(first.results.length, 2);
  assert.equal(first.results[0].excerpt_truncated, true);
  const seen = new Set(first.results.map((r) => r.id));
  let offset = first.next_offset;
  while (offset !== null) {
    const page = search(root, records, { query: "本文", limit: 2, offset });
    page.results.forEach((r) => seen.add(r.id));
    offset = page.next_offset;
  }
  assert.equal(seen.size, 7);
  const all = show(records, "PDR-1", {
    sections: ["decision", "scope"],
    lines: 100,
  });
  const chunks = [];
  offset = 0;
  do {
    const page = show(records, "PDR-1", {
      sections: ["decision", "scope"],
      lines: 2,
      offset,
    });
    chunks.push(page.body);
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(chunks.join("\n"), all.body);
  assert.throws(
    () => show(records, "PDR-1", { sections: ["unknown"] }),
    /section/,
  );
});

test("large collections return only bounded candidate cards", (t) => {
  const root = fixture(t);
  for (let i = 0; i < 1000; i++)
    put(
      root,
      `PDR-${i}`,
      {},
      { decision: `共通の方針 ${i}。${"背景の詳細。".repeat(20)}` },
    );
  const result = search(root, readRecords(root), { query: "共通" });
  assert.equal(result.total, 1000);
  assert.equal(result.results.length, 5);
  assert.equal(result.next_offset, 5);
  assert.ok(JSON.stringify(result).length < 8000);
});

test("resolve pages many unresolved alternatives without claiming an accepted decision", (t) => {
  const root = fixture(t);
  for (let i = 0; i < 12; i++)
    put(root, `PDR-${i}`, { key: "pending.choice", status: "proposed" });
  const records = readRecords(root);
  const first = resolveKey(records, "pending.choice");
  assert.equal(first.current, null);
  assert.equal(first.attention_total, 12);
  assert.equal(first.attention.length, 5);
  assert.equal(first.attention_next_offset, 5);
  assert.equal(
    resolveKey(records, "pending.choice", { offset: 10 }).attention_next_offset,
    null,
  );
});

test("CLI validates catalog freshness and rejects invalid commands/options", (t) => {
  const root = fixture(t);
  put(root, "PDR-1");
  assert.equal(run(root, "catalog", "--write").status, 0);
  assert.equal(run(root, "check").status, 0);
  put(root, "PDR-1", {}, { title: "タイトルを変更する" });
  assert.match(run(root, "check").stderr, /catalog is stale/);
  assert.equal(run(root, "catalog", "--write").status, 0);
  assert.equal(run(root, "check").status, 0);
  for (const args of [
    ["resolve"],
    ["search", "--limit", "0", "返答"],
    ["show", "PDR-1", "--lines", "0"],
    ["unknown"],
  ])
    assert.equal(run(root, ...args).status, 1, args.join(" "));
  const noMatches = run(root, "search", "存在しない用語");
  assert.equal(noMatches.status, 0);
  assert.ok(JSON.parse(noMatches.stdout).warning);
  assert.equal(
    readFileSync(join(root, "docs/pdr/index.md"), "utf8").includes(
      "タイトルを変更する",
    ),
    true,
  );
});

test("context includes staged, working and untracked paths without shell expansion", (t) => {
  const root = fixture(t);
  put(root, "PDR-1", { paths: ["app.mjs", "new.mjs"] });
  writeFileSync(join(root, "app.mjs"), "original\n");
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=PDR Test",
    "-c",
    "user.email=pdr@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  );
  writeFileSync(join(root, "app.mjs"), "changed\n");
  git("add", "app.mjs");
  writeFileSync(join(root, "new.mjs"), "untracked\n");
  assert.deepEqual(
    new Set(changedPaths(root, "HEAD...HEAD")),
    new Set(["app.mjs", "new.mjs"]),
  );
  const result = run(root, "context", "--diff", "HEAD...HEAD");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].id, "PDR-1");
  assert.throws(() => changedPaths(root, "--output=unexpected"), /Invalid/);
  assert.throws(() => changedPaths(root, "HEAD;touch unexpected"));
  assert.equal(existsSync(join(root, "unexpected")), false);
});

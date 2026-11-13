import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JSON_SCHEMA, load } from "js-yaml";

export const statuses = [
  "proposed",
  "accepted",
  "superseded",
  "rejected",
  "unverified",
];
export const sectionNames = {
  decision: "決定",
  rationale: "理由",
  scope: "範囲と例外",
  alternatives: "選択肢と影響",
  open: "未決事項",
  revisit: "再検討条件",
};
const fields = new Set([
  "schema",
  "id",
  "key",
  "status",
  "date",
  "areas",
  "keywords",
  "paths",
  "symbols",
  "supersedes",
  "decided_by",
]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const posix = (path) => path.split(sep).join("/");
const text = (value) => typeof value === "string" && value.trim().length > 0;
const slug = (value) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/\s/g, "-");

function markdownHeadings(content) {
  const result = [];
  let fence;
  for (const [index, line] of content.split("\n").entries()) {
    const boundary = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (boundary) {
      if (!fence) fence = boundary;
      else if (boundary[0] === fence[0] && boundary.length >= fence.length)
        fence = undefined;
      continue;
    }
    const heading = !fence && /^ {0,3}(#{1,6}) (.+)$/.exec(line);
    if (heading)
      result.push({ index, level: heading[1].length, text: heading[2] });
  }
  return result;
}

export function normalize(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\d)[,_](?=\d)/g, "$1")
    .replace(/\b(\d+(?:\.\d+)?)k\b/g, (_, n) => String(Number(n) * 1000));
}

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`PDR symlinks are not supported: ${path}`);
      return entry.isDirectory()
        ? filesIn(path)
        : entry.name.endsWith(".md")
          ? [path]
          : [];
    })
    .sort();
}

export function parseRecord(content, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) throw new Error(`${file}: YAML front matter is required`);
  const meta = load(match[1], { schema: JSON_SCHEMA });
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new Error(`${file}: front matter must be an object`);
  for (const field of Object.keys(meta))
    if (!fields.has(field)) throw new Error(`${file}: unknown field ${field}`);
  for (const field of ["id", "key", "status", "date"])
    if (!text(meta[field]))
      throw new Error(`${file}: ${field} must be a nonempty string`);
  if (meta.schema !== 1) throw new Error(`${file}: schema must be 1`);
  if (!/^PDR-[A-Za-z0-9-]+$/.test(meta.id))
    throw new Error(`${file}: invalid id`);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(meta.key))
    throw new Error(`${file}: invalid key`);
  if (!statuses.includes(meta.status))
    throw new Error(`${file}: invalid status`);
  const date = new Date(meta.date);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(meta.date) ||
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== meta.date
  )
    throw new Error(`${file}: invalid ISO date`);
  for (const field of ["areas", "keywords", "paths", "symbols", "supersedes"]) {
    if (
      meta[field] !== undefined &&
      (!Array.isArray(meta[field]) || !meta[field].every(text))
    )
      throw new Error(`${file}: ${field} must be an array of nonempty strings`);
    meta[field] ??= [];
  }
  if (!meta.areas.length)
    throw new Error(`${file}: at least one area is required`);
  if (meta.decided_by !== undefined && !text(meta.decided_by))
    throw new Error(`${file}: invalid decided_by`);
  if (meta.status === "accepted" && !text(meta.decided_by))
    throw new Error(`${file}: accepted decisions require decided_by`);
  const body = content.slice(match[0].length).trim();
  const headings = markdownHeadings(body);
  const title = headings.find((h) => h.level === 1)?.text;
  if (!title) throw new Error(`${file}: a title is required`);
  const sections = {};
  const lines = body.split("\n");
  const sectionHeadings = headings.filter((h) => h.level === 2);
  for (const [i, heading] of sectionHeadings.entries()) {
    const current = Object.entries(sectionNames).find(
      ([, label]) => label === heading.text,
    )?.[0];
    if (!current) throw new Error(`${file}: unknown section ${heading.text}`);
    if (current in sections)
      throw new Error(`${file}: duplicate section ${heading.text}`);
    sections[current] = lines
      .slice(heading.index + 1, sectionHeadings[i + 1]?.index)
      .join("\n")
      .trim();
  }
  for (const key of ["decision", "rationale", "scope"])
    if (!text(sections[key]))
      throw new Error(`${file}: section ${sectionNames[key]} is required`);
  return { ...meta, file, title, body, sections, record_hash: hash(content) };
}

function checkLink(root, record, link) {
  if (/^https?:\/\//.test(link)) {
    new URL(link);
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(link))
    throw new Error(`${record.file}: unsupported link ${link}`);
  const [part, fragment] = link.split("#");
  const destination = part
    ? resolve(root, dirname(record.file), decodeURIComponent(part))
    : resolve(root, record.file);
  const rel = relative(root, destination);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`${record.file}: link escapes repository: ${link}`);
  if (!existsSync(destination))
    throw new Error(`${record.file}: missing local link ${link}`);
  const actual = relative(realpathSync(root), realpathSync(destination));
  if (isAbsolute(actual) || actual === ".." || actual.startsWith(`..${sep}`))
    throw new Error(`${record.file}: link target escapes repository: ${link}`);
  if (fragment) {
    const headings = markdownHeadings(readFileSync(destination, "utf8")).map(
      (h) => slug(h.text),
    );
    if (!headings.includes(decodeURIComponent(fragment)))
      throw new Error(`${record.file}: missing heading ${link}`);
  }
}

export function validateRecords(root, records) {
  const byId = new Map();
  const accepted = new Set();
  const successors = new Map();
  for (const record of records) {
    if (byId.has(record.id)) throw new Error(`Duplicate PDR id: ${record.id}`);
    byId.set(record.id, record);
    if (record.status === "accepted") {
      if (accepted.has(record.key))
        throw new Error(`Multiple accepted decisions for ${record.key}`);
      accepted.add(record.key);
    }
    const links = [...record.body.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map(
      (m) => m[1],
    );
    for (const link of links) checkLink(root, record, link);
  }
  for (const record of records)
    for (const previous of record.supersedes) {
      const old = byId.get(previous);
      if (!old || old.key !== record.key)
        throw new Error(
          `${record.id}: supersedes must refer to the same decision key`,
        );
      if (["accepted", "superseded"].includes(record.status)) {
        if (old.status !== "superseded")
          throw new Error(`${record.id}: ${previous} must be superseded`);
        if (successors.has(previous))
          throw new Error(`${previous}: multiple successors`);
        successors.set(previous, record.id);
      }
    }
  const visited = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`Supersession cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const old of byId.get(id).supersedes) visit(old);
    visiting.delete(id);
    visited.add(id);
  };
  for (const record of records) {
    visit(record.id);
    if (record.status === "superseded" && !successors.has(record.id))
      throw new Error(`${record.id}: missing successor`);
  }
  return { byId, successors };
}

export function readRecords(root) {
  const records = filesIn(join(root, "docs/pdr/records")).map((path) =>
    parseRecord(readFileSync(path, "utf8"), posix(relative(root, path))),
  );
  validateRecords(root, records);
  return records;
}

function indexContent(record) {
  return normalize(
    [
      record.key,
      record.title,
      record.body,
      ...record.areas,
      ...record.keywords,
      ...record.symbols,
      ...record.symbols.map((s) => s.replace(/([a-z])([A-Z])/g, "$1 $2")),
    ].join("\n"),
  );
}

export function openIndex(root, records) {
  // Include uncommitted/untracked documents and deletions, not just git HEAD.
  const fingerprint = hash(
    JSON.stringify({
      engine: hash(readFileSync(new URL(import.meta.url))),
      node: process.versions.node,
      records: records.map((r) => [r.file, r.record_hash]),
    }),
  );
  const path = join(root, ".cache/pdr/index.sqlite");
  let cached;
  try {
    cached = new DatabaseSync(path, { readOnly: true });
    if (
      cached
        .prepare("SELECT value FROM metadata WHERE key = 'fingerprint'")
        .get()?.value === fingerprint
    )
      return { db: cached, fingerprint };
  } catch {
    /* Missing or corrupt caches are always rebuilt from Markdown. */
  }
  cached?.close();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let db;
  try {
    db = new DatabaseSync(temporary);
    db.exec(
      "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, content, tokenize = 'trigram');",
    );
    const insert = db.prepare("INSERT INTO search(id, content) VALUES (?, ?)");
    db.exec("BEGIN");
    for (const record of records) insert.run(record.id, indexContent(record));
    db.prepare(
      "INSERT INTO metadata(key, value) VALUES ('fingerprint', ?)",
    ).run(fingerprint);
    db.exec("COMMIT");
    db.close();
    db = undefined;
    renameSync(temporary, path);
  } finally {
    db?.close();
    rmSync(temporary, { force: true });
  }
  return { db: new DatabaseSync(path, { readOnly: true }), fingerprint };
}

function pathMatch(pattern, path) {
  const expression = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${expression}$`).test(path);
}

export function card(record, chars = 200) {
  const decision = record.sections.decision.replace(/\s+/g, " ");
  return {
    id: record.id,
    key: record.key,
    title: record.title,
    status: record.status,
    authoritative: record.status === "accepted",
    areas: record.areas,
    file: record.file,
    excerpt: decision.slice(0, chars),
    excerpt_truncated: decision.length > chars,
    record_hash: record.record_hash,
  };
}

export function search(
  root,
  records,
  {
    query = "",
    paths = [],
    limit = 5,
    offset = 0,
    history = false,
    chars = 200,
  } = {},
) {
  if (!query.trim() && !paths.length)
    throw new Error(
      "Provide a query or --path; use catalog to browse all PDRs",
    );
  const normalizedQuery = normalize(query);
  const terms = [
    ...new Set([
      ...(normalizedQuery.match(
        /[a-z0-9_.-]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+|[\p{L}\p{N}]+/gu,
      ) ?? []),
      ...(normalizedQuery.match(/\p{Script=Han}{2,}/gu) ?? []),
    ]),
  ];
  // Natural Japanese questions have no word separators. Low-weight bigram
  // overlap supplements literal matches; it never turns a draft into policy.
  const approximate = [
    ...new Set(
      terms.flatMap((term) => {
        const points = [...term];
        return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
          term,
        ) && points.length > 3
          ? points.slice(0, -1).map((c, i) => c + points[i + 1])
          : [];
      }),
    ),
  ];
  const { db, fingerprint } = openIndex(root, records);
  const fts = new Map();
  try {
    const long = terms.filter((s) => [...s].length >= 3);
    if (long.length)
      for (const row of db
        .prepare(
          "SELECT id, bm25(search) AS rank FROM search WHERE search MATCH ?",
        )
        .all(long.map((s) => `"${s.replaceAll('"', '""')}"`).join(" OR ")))
        fts.set(row.id, -row.rank);
  } finally {
    db.close();
  }
  const { byId, successors } = validateRecords(root, records);
  const hits = new Map();
  for (const record of records) {
    let score = fts.has(record.id) ? 1 + Math.min(fts.get(record.id), 1) : 0;
    let literalMatch = fts.has(record.id);
    const approximateMatches = new Set();
    const reasons = [];
    for (const [label, value, weight] of [
      ["key", record.key, 14],
      ["title", record.title, 10],
      ["keywords", [...record.keywords, ...record.symbols].join(" "), 10],
      ["decision", record.sections.decision, 5],
      ["body", record.body, 1],
    ]) {
      const normalized = normalize(value);
      if (terms.some((term) => normalized.includes(term))) {
        literalMatch = true;
        score += weight;
        reasons.push(label);
      } else {
        const matched = approximate.filter((term) => normalized.includes(term));
        matched.forEach((term) => approximateMatches.add(term));
        const overlap = matched.length;
        if (overlap) {
          score += (weight * Math.min(overlap, 3)) / 10;
          reasons.push(`approximate:${label}`);
        }
      }
    }
    if (
      paths.some((path) =>
        record.paths.some((pattern) => pathMatch(pattern, path)),
      )
    ) {
      literalMatch = true;
      score += 12;
      reasons.push("path");
    }
    if (!score || (!literalMatch && approximateMatches.size < 2)) continue;
    let target = record;
    if (!history && record.status === "superseded") {
      while (successors.has(target.id))
        target = byId.get(successors.get(target.id));
      reasons.push(`successor-of:${record.id}`);
    }
    score += target.status === "accepted" ? 2 : 0;
    const prior = hits.get(target.id);
    if (!prior || score > prior.score)
      hits.set(target.id, { record: target, score, reasons });
    else prior.reasons = [...new Set([...prior.reasons, ...reasons])];
  }
  const sorted = [...hits.values()].sort(
    (a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id),
  );
  const attention = sorted.filter((r) =>
    ["proposed", "unverified"].includes(r.record.status),
  );
  return {
    fingerprint,
    total: sorted.length,
    offset,
    next_offset: offset + limit < sorted.length ? offset + limit : null,
    warning: sorted.length
      ? null
      : "No matches do not prove that no decision exists. Try aliases, identifiers and other paths before making a new product decision.",
    attention: {
      total: attention.length,
      ids: attention.slice(0, limit).map((r) => r.record.id),
    },
    results: sorted
      .slice(offset, offset + limit)
      .map((hit) => ({ ...card(hit.record, chars), matched_on: hit.reasons })),
  };
}

export function show(
  records,
  id,
  { sections = [], offset = 0, lines = 80 } = {},
) {
  const record = records.find((r) => r.id === id);
  if (!record) throw new Error(`Unknown PDR: ${id}`);
  for (const section of sections)
    if (!(section in record.sections))
      throw new Error(`${id}: unknown/missing section ${section}`);
  const body = sections.length
    ? sections
        .map((s) => `## ${sectionNames[s]}\n\n${record.sections[s]}`)
        .join("\n\n")
    : record.body;
  const all = body.split("\n");
  return {
    ...card(record),
    decided_by: record.decided_by ?? null,
    supersedes: record.supersedes,
    successors: records
      .filter(
        (r) =>
          ["accepted", "superseded"].includes(r.status) &&
          r.supersedes.includes(id),
      )
      .map((r) => ({ id: r.id, status: r.status })),
    offset,
    total_lines: all.length,
    next_offset: offset + lines < all.length ? offset + lines : null,
    body: all.slice(offset, offset + lines).join("\n"),
  };
}

export function resolveKey(
  records,
  key,
  { limit = 5, offset = 0, chars = 200 } = {},
) {
  const matches = records.filter((r) => r.key === key);
  const accepted = matches.find((r) => r.status === "accepted");
  const attention = matches.filter((r) =>
    ["proposed", "unverified"].includes(r.status),
  );
  return {
    key,
    state: accepted ? "accepted" : "no_accepted_decision",
    current: accepted ? card(accepted, chars) : null,
    attention_total: attention.length,
    attention_next_offset:
      offset + limit < attention.length ? offset + limit : null,
    attention: attention
      .slice(offset, offset + limit)
      .map((r) => card(r, chars)),
  };
}

export function catalog(records) {
  return [
    "# PDR 一覧",
    "",
    "`pnpm pdr catalog --write` で生成。直接編集しない。Agent は一覧全体を読み込まず検索 CLI を使う。",
    "",
    "| ID | 状態 | 論点 | 決定 |",
    "| --- | --- | --- | --- |",
    ...records.map(
      (r) =>
        `| [${r.id}](${posix(relative("docs/pdr", r.file))}) | ${r.status} | ${r.key} | ${r.title.replaceAll("|", "\\|")} |`,
    ),
    "",
  ].join("\n");
}

export function changedPaths(root, ref) {
  if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref))
    throw new Error("Invalid --diff revision/range");
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\0")
      .filter(Boolean);
  return [
    ...new Set([
      ...git(["diff", "--name-only", "-z", ref, "--"]),
      ...git(["diff", "--name-only", "-z", "HEAD", "--"]),
      ...git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]),
  ];
}

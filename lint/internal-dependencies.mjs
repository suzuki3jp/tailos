import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync, Visitor } from "vite";

const repository = fileURLToPath(new URL("../", import.meta.url));
const sourceFile = /\.[cm]?[jt]sx?$/;
const testFile = /(?:\.(?:test|spec)|\/testing)\.[cm]?[jt]sx?$/;
const workspaceManifest = /^(?:apps|packages)\/[^/]+\/package\.json$/;

function literal(node) {
  if (node?.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0].value.cooked;
}

export function moduleImports(filename, source) {
  const { program, errors } = parseSync(filename, source);
  if (errors.length)
    throw new Error(
      `${filename}: ${errors.map((error) => error.message).join("\n")}`,
    );

  const imports = [];
  function record(target, typeOnly = false) {
    const specifier = literal(target);
    if (typeof specifier === "string") imports.push({ specifier, typeOnly });
  }
  function declaration(node) {
    const typeOnly =
      node.importKind === "type" ||
      node.exportKind === "type" ||
      (node.specifiers?.length > 0 &&
        node.specifiers.every(
          (item) => item.importKind === "type" || item.exportKind === "type",
        ));
    record(node.source, Boolean(typeOnly));
  }
  new Visitor({
    ImportDeclaration: declaration,
    ExportNamedDeclaration: declaration,
    ExportAllDeclaration: declaration,
    ImportExpression: (node) => record(node.source),
    TSImportType: (node) => record(node.source, true),
    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type === "TSExternalModuleReference")
        record(node.moduleReference.expression, node.importKind === "type");
    },
    CallExpression(node) {
      if (node.callee.type === "Identifier" && node.callee.name === "require")
        record(node.arguments[0]);
    },
  }).visit(program);
  return imports;
}

function internalPath(from, specifier, workspaces) {
  if (specifier.startsWith("."))
    return posix.join(posix.dirname(from), specifier);
  if (specifier.startsWith("@/")) {
    const workspace = from.split("/").slice(0, 2).join("/");
    return posix.join(workspace, "src", specifier.slice(2));
  }
  const workspaceImport = /^(@tailos\/[^/]+)(.*)$/.exec(specifier);
  if (!workspaceImport) return;
  const [, name, subpath] = workspaceImport;
  const workspace = workspaces.get(name);
  const entry = workspace?.exports?.[`.${subpath}`];
  const target = typeof entry === "string" ? entry : entry?.types;
  if (!target)
    throw new Error(`${from}: ${specifier} is not a workspace export.`);
  return posix.join(workspace.root, target);
}

function resolveModule(from, specifier, workspaces, files) {
  const base = internalPath(from, specifier, workspaces);
  if (base === undefined) return;
  const target = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    base.replace(/\.js$/, ".ts"),
  ].find((candidate) => files.has(candidate));
  if (!target)
    throw new Error(
      `${from}: cannot resolve ${specifier} to a repository file.`,
    );
  return target;
}

export function buildInternalGraph(root = repository) {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );
  const files = new Set(
    listed
      .split("\0")
      .filter((file) => file && existsSync(join(root, file)))
      .sort(),
  );
  const workspaces = new Map();
  for (const path of files) {
    if (!workspaceManifest.test(path)) continue;
    const { name, exports } = JSON.parse(
      readFileSync(join(root, path), "utf8"),
    );
    workspaces.set(name, { root: posix.dirname(path), exports });
  }

  const graph = new Map();
  for (const file of files) {
    if (!sourceFile.test(file) || testFile.test(file)) continue;
    const edges = new Map();
    for (const { specifier, typeOnly } of moduleImports(
      file,
      readFileSync(join(root, file), "utf8"),
    )) {
      const target = resolveModule(file, specifier, workspaces, files);
      if (target) edges.set(target, (edges.get(target) ?? true) && typeOnly);
    }
    graph.set(file, edges);
  }
  return graph;
}

export function findImportCycle(graph) {
  const visited = new Set();
  const visiting = new Map();
  const path = [];
  function visit(file) {
    if (visited.has(file)) return;
    if (visiting.has(file)) return [...path.slice(visiting.get(file)), file];
    visiting.set(file, path.length);
    path.push(file);
    for (const target of graph.get(file)?.keys() ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const graph = buildInternalGraph();
  const entries = Array.from(graph, ([file, edges]) => [
    file,
    Object.fromEntries(
      Array.from(edges, ([target, typeOnly]) => [
        target,
        typeOnly ? "type" : "runtime",
      ]),
    ),
  ]);
  process.stdout.write(
    JSON.stringify(Object.fromEntries(entries), null, 2) + "\n",
  );
}

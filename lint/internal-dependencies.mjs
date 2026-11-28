import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync, Visitor } from "vite";

const repository = fileURLToPath(new URL("../", import.meta.url));
const sourceFile = /\.[cm]?[jt]sx?$/;
const testFile = /(?:\.(?:test|spec)|(?:^|\/)testing)\.[cm]?[jt]sx?$/;
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
  function record(target, typeOnly = false, mode = "import") {
    const specifier = literal(target);
    if (typeof specifier === "string")
      imports.push({ specifier, typeOnly, mode });
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
        record(
          node.moduleReference.expression,
          node.importKind === "type",
          "require",
        );
    },
    CallExpression(node) {
      if (node.callee.type === "Identifier" && node.callee.name === "require")
        record(node.arguments[0], false, "require");
    },
  }).visit(program);
  return imports;
}

function workspaceRoot(file) {
  return file.split("/").slice(0, 2).join("/");
}

function exportTarget(entry, conditions) {
  if (entry === null || typeof entry === "string") return entry;
  if (typeof entry !== "object") return;
  for (const [condition, value] of Object.entries(entry)) {
    if (conditions.has(condition)) {
      const target = exportTarget(value, conditions);
      if (target !== undefined) return target;
    }
  }
}

function internalPath(from, { specifier, mode, typeOnly }, workspaces) {
  if (specifier.startsWith("."))
    return posix.join(posix.dirname(from), specifier);
  if (specifier.startsWith("@/"))
    return posix.join(workspaceRoot(from), "src", specifier.slice(2));
  const workspaceImport = /^(@tailos\/[^/]+)(.*)$/.exec(specifier);
  if (!workspaceImport) return;
  const [, name, subpath] = workspaceImport;
  const workspace = workspaces.byName.get(name);
  const entry = workspace?.exports?.[`.${subpath}`];
  if (entry === undefined)
    throw new Error(`${from}: ${specifier} is not a workspace export.`);
  const conditions = new Set(["default", mode]);
  if (typeOnly) conditions.add("types");
  const target = exportTarget(entry, conditions);
  if (typeof target !== "string")
    throw new Error(
      `${from}: ${specifier} has no export for ${typeOnly ? "types" : `runtime ${mode}`}. Use a compatible public export.`,
    );
  const importer = workspaces.byRoot.get(workspaceRoot(from));
  if (importer && importer !== workspace && !importer.dependencies.has(name))
    throw new Error(
      `${from}: declare workspace dependency ${name} in ${importer.root}/package.json before importing ${specifier}.`,
    );
  return posix.join(workspace.root, target);
}

function resolveModule(from, dependency, workspaces, files) {
  const { specifier } = dependency;
  const base = internalPath(from, dependency, workspaces);
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
  if (testFile.test(target))
    throw new Error(
      `${from}: production imports cannot reference test module ${target}. Move shared code to a production module.`,
    );
  const importer = workspaces.byRoot.get(workspaceRoot(from));
  const imported = workspaces.byRoot.get(workspaceRoot(target));
  if (
    importer &&
    imported &&
    importer !== imported &&
    !specifier.startsWith("@tailos/")
  )
    throw new Error(
      `${from}: ${specifier} reaches into ${imported.name}. Import from an export in ${imported.root}/package.json.`,
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
  const workspaces = { byName: new Map(), byRoot: new Map() };
  for (const path of files) {
    if (!workspaceManifest.test(path)) continue;
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    const workspace = {
      name: manifest.name,
      root: posix.dirname(path),
      exports: manifest.exports,
      dependencies: new Set(
        Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        }),
      ),
    };
    workspaces.byName.set(workspace.name, workspace);
    workspaces.byRoot.set(workspace.root, workspace);
  }

  const graph = new Map();
  for (const file of files) {
    if (!sourceFile.test(file) || testFile.test(file)) continue;
    const edges = new Map();
    for (const dependency of moduleImports(
      file,
      readFileSync(join(root, file), "utf8"),
    )) {
      const target = resolveModule(file, dependency, workspaces, files);
      if (target)
        edges.set(target, (edges.get(target) ?? true) && dependency.typeOnly);
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

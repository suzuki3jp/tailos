/**
 * Tailos API import boundaries
 *
 *                      worker / bootstrap
 *                      /                \
 *              presentation          infrastructure
 *                      \                /
 *                          application
 *
 * Production modules may import from their own layer. Presentation and
 * infrastructure may also import application modules. Only composition
 * modules may connect presentation to infrastructure. Cloudflare Bindings
 * are available to presentation and infrastructure as a type-only import.
 *
 * Application modules can import shared contracts from @tailos/core and
 * use Valibot. Presentation keeps HTTP dependencies such as Hono, and
 * infrastructure owns platform and provider SDKs.
 *
 * The rule checks imports, re-exports, and dynamic imports. For example,
 * importing a D1 adapter directly from a route is an error. Tests and
 * their testing.ts fixtures can cross layers to exercise real adapters.
 * Production modules cannot import those test files or fixtures.
 */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../apps/api/src/", import.meta.url));
const sourceAlias = "#api/";
const layers = new Set([
  "application",
  "presentation",
  "infrastructure",
  "bootstrap",
]);
const sdk =
  /^(?:@cloudflare\/|cloudflare:|drizzle-orm(?:\/|$)|@better-auth\/|better-auth(?:\/|$)|jose(?:\/|$))/;
const testModule = /(?:\.test|[/\\]testing)(?:\.[cm]?[jt]sx?)?$/;
const applicationPackage = /^(?:@tailos\/core(?:\/|$)|valibot$)/;

function area(path) {
  const within = relative(sourceRoot, path).replaceAll("\\", "/");
  if (within === "" || within === ".." || within.startsWith("../")) return null;
  if (within === "worker.ts") return "bootstrap";
  if (within === "bindings.ts") return "bindings";
  const first = within.split("/")[0];
  return layers.has(first) ? first : "unassigned";
}

const layerImports = {
  application: new Set(["application"]),
  presentation: new Set(["presentation", "application"]),
  infrastructure: new Set(["infrastructure", "application"]),
  bindings: new Set(["application", "infrastructure"]),
};

export default {
  meta: { name: "tailos" },
  rules: {
    "api-layers": {
      create(context) {
        const filename = resolve(context.filename);
        const from = area(filename);
        if (!from || testModule.test(filename)) return {};

        function report(node, message) {
          context.report({ node, message });
        }

        function check(node, source, typeOnly = false) {
          if (!source) return;
          const specifier = source.value;
          if (typeof specifier !== "string") {
            if (from !== "bootstrap")
              report(node, "Use a static import path in API layers.");
            return;
          }
          let target;
          if (specifier.startsWith(sourceAlias)) {
            target = resolve(sourceRoot, specifier.slice(sourceAlias.length));
          } else if (specifier.startsWith(".") || isAbsolute(specifier)) {
            target = resolve(dirname(filename), specifier);
          }
          if (target) {
            if (testModule.test(target)) {
              report(
                node,
                `Production API modules cannot import test modules (${specifier}).`,
              );
              return;
            }
            if (from === "bootstrap") return;
            const to = area(target);
            if (
              to === "bindings" &&
              typeOnly &&
              (from === "presentation" || from === "infrastructure")
            )
              return;
            if (
              to &&
              layerImports[from]?.has(to) &&
              (from !== "bindings" || typeOnly)
            )
              return;
            report(
              node,
              `API ${from} cannot import ${to ?? "outside src"} (${specifier}).`,
            );
          } else if (
            (from === "application" && !applicationPackage.test(specifier)) ||
            (from === "presentation" && sdk.test(specifier)) ||
            (from === "infrastructure" && /^hono(?:\/|$)/.test(specifier)) ||
            (from === "bindings" && !typeOnly)
          ) {
            report(node, `API ${from} cannot import ${specifier}.`);
          }
        }

        return {
          Program(node) {
            if (from === "unassigned")
              report(node, "Place API modules in a layer or bootstrap.");
          },
          ImportDeclaration(node) {
            check(
              node,
              node.source,
              node.importKind === "type" ||
                (node.specifiers.length > 0 &&
                  node.specifiers.every((item) => item.importKind === "type")),
            );
          },
          ExportNamedDeclaration(node) {
            check(node, node.source, node.exportKind === "type");
          },
          ExportAllDeclaration(node) {
            check(node, node.source, node.exportKind === "type");
          },
          CallExpression(node) {
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "require"
            )
              check(node, node.arguments[0]);
          },
          ImportExpression(node) {
            check(node, node.source);
          },
          TSImportType(node) {
            const source = node.source ?? node.argument;
            check(node, source?.literal ?? source, true);
          },
          TSImportEqualsDeclaration(node) {
            check(
              node,
              node.moduleReference.expression,
              node.importKind === "type",
            );
          },
        };
      },
    },
  },
};

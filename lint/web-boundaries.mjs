import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../apps/web/src/", import.meta.url));
const layers = new Set([
  "app",
  "worker",
  "_pages",
  "widgets",
  "features",
  "entities",
  "shared",
]);
const testModule = /(?:\.(?:test|spec)|[/\\]testing)(?:\.[cm]?[jt]sx?)?$/;
const routeModule =
  /(?:^|\/)(?:page|layout|route|loading|error|not-found|global-error|default)(?:\.[cm]?[jt]sx?)?$/;

function publicEntry(parts) {
  const name = parts.at(-1)?.replace(/\.[cm]?[jt]sx?$/, "");
  if (["_pages", "widgets", "features", "entities"].includes(parts[0])) {
    return (
      parts.length === 2 ||
      (parts.length === 3 && ["index", "index.server"].includes(name))
    );
  }
  if (parts[0] === "shared") {
    const depth = ["ui", "lib"].includes(parts[1]) ? 3 : 2;
    return (
      parts.length === depth ||
      (parts.length === depth + 1 && ["index", "index.server"].includes(name))
    );
  }
  return false;
}

// Steiger handles dependencies within FSD layers. This rule covers the
// framework/Worker adapters excluded from its tree and workspace contracts.
// The explicit root also lets CLI fixtures exercise the real parser and rule.
export function createWebBoundaryRule(root) {
  function location(filename) {
    const path = relative(root, filename).replaceAll("\\", "/");
    if (path === ".." || path.startsWith("../") || isAbsolute(path))
      return null;
    return path.split("/");
  }

  return {
    create(context) {
      const filename = resolve(context.filename);
      const from = location(filename);
      if (!from) return {};

      // A colocated test may import its own route; routes still cannot compose
      // other routes, and tests cannot reach unrelated framework modules.
      const testSubject = filename.replace(
        /\.(?:test|spec)(\.[cm]?[jt]sx?)$/,
        "$1",
      );

      function report(node, message) {
        context.report({ node, message });
      }

      function check(node, source, typeOnly = false) {
        if (!source) return;
        const specifier = source.value;
        if (typeof specifier !== "string") {
          report(node, "Use a static import path in Web modules.");
          return;
        }
        if (/^@tailos\/(?:api|runner)(?:\/|$)/.test(specifier)) {
          if (specifier === "@tailos/api/browser" && typeOnly) return;
          report(
            node,
            "Web may only import API's @tailos/api/browser contract as a type.",
          );
          return;
        }

        let target;
        if (specifier.startsWith("@/")) {
          target = resolve(root, specifier.slice(2));
        } else if (specifier.startsWith(".") || isAbsolute(specifier)) {
          target = resolve(dirname(filename), specifier);
        } else {
          return;
        }
        const to = location(target);
        if (!to || !layers.has(to[0])) {
          report(
            node,
            "Import Web modules through their src layers; use package contracts outside Web.",
          );
          return;
        }
        if (!testModule.test(filename) && testModule.test(target)) {
          report(node, "Production Web modules cannot import test modules.");
          return;
        }
        if (["app", "worker"].includes(to[0])) {
          if (from[0] !== to[0]) {
            report(
              node,
              "FSD layers and adapters cannot depend on another Web adapter.",
            );
          } else if (
            from[0] === "app" &&
            routeModule.test(to.join("/")) &&
            !(
              testSubject !== filename &&
              (testSubject === target ||
                testSubject.replace(/\.[cm]?[jt]sx?$/, "") === target)
            )
          ) {
            report(
              node,
              "Import a page slice instead of another framework route module.",
            );
          }
          return;
        }
        if (
          from[0] === "worker" &&
          !(to[0] === "shared" && to[1] === "config")
        ) {
          report(
            node,
            "The Web Worker may only import public configuration from FSD layers.",
          );
          return;
        }
        if (["app", "worker"].includes(from[0]) && !publicEntry(to)) {
          report(
            node,
            "Web adapters must use the public API of a slice or Shared module.",
          );
        }
      }

      return {
        Program(node) {
          if (!layers.has(from[0]))
            report(node, "Place Web source in an FSD layer, app, or worker.");
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
          check(
            node,
            node.source,
            node.exportKind === "type" ||
              (node.specifiers.length > 0 &&
                node.specifiers.every((item) => item.exportKind === "type")),
          );
        },
        ExportAllDeclaration(node) {
          check(node, node.source, node.exportKind === "type");
        },
        ImportExpression(node) {
          check(node, node.source);
        },
        CallExpression(node) {
          if (
            node.callee.type === "Identifier" &&
            node.callee.name === "require"
          )
            check(node, node.arguments[0]);
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
  };
}

export default {
  meta: { name: "tailos-web" },
  rules: { boundaries: createWebBoundaryRule(sourceRoot) },
};

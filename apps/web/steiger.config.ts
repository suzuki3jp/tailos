import { defineConfig } from "steiger";
import fsd from "@feature-sliced/steiger-plugin";

export default defineConfig([
  ...fsd.configs.recommended,
  {
    // The plugin recognizes _pages as Pages for imports, but its typo rule
    // still flags the prefixed directory name. Keep this exception local.
    files: ["./src/_pages/**"],
    rules: { "fsd/typo-in-layer-name": "off" },
  },
  {
    // Framework routes and the Worker use their own file conventions.
    // Oxlint's web-boundaries rule still checks all their imports.
    ignores: ["./src/app/**", "./src/worker/**"],
  },
  {
    rules: {
      "fsd/import-locality": "error",
      "fsd/no-wildcard-exports": "error",
      "fsd/insignificant-slice": "warn",
      "fsd/excessive-slicing": "warn",
    },
  },
]);

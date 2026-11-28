import { defineConfig } from "vitest/config";

// Each app loads this with its own root and tsconfig.
export default defineConfig({
  resolve: { tsconfigPaths: true },
});

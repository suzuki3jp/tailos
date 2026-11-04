import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/helpers/cloudflare.ts', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});

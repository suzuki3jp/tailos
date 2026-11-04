import { build } from 'esbuild';
await build({ entryPoints: ['src/runtime/server.ts'], outfile: 'dist/runner.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: true });

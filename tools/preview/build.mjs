import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { origins, previewName } from "./config.mjs";

const [number, outputDir] = process.argv.slice(2);
const { web } = origins(previewName(number));
const output = resolve(outputDir);
mkdirSync(output, { recursive: true });
execFileSync(
  "pnpm",
  [
    "--filter",
    "@tailos/api",
    "exec",
    "wrangler",
    "deploy",
    "--dry-run",
    "--config",
    "wrangler.preview.jsonc",
    "--outdir",
    resolve(output, "api"),
  ],
  { stdio: "inherit" },
);
execFileSync("pnpm", ["--filter", "@tailos/web", "run", "build"], {
  stdio: "inherit",
  env: { ...process.env, VITE_API_ORIGIN: web, VITE_TAILOS_PREVIEW: "1" },
});
cpSync("apps/web/dist", resolve(output, "web"), { recursive: true });

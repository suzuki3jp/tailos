import { execFile, type ExecFileOptions } from "node:child_process";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import * as v from "valibot";

const exec = promisify(execFile);

export type DependencySetupResult =
  | { status: "skipped" | "succeeded" }
  | {
      status: "failed";
      exitCode?: number;
      code?: string;
      signal?: string;
      output: string;
    };

const fetchErrorSchema = v.object({
  code: v.optional(v.nullable(v.union([v.number(), v.string()]))),
  signal: v.optional(v.nullable(v.string())),
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
});

// Only the lockfile is copied. Repository .npmrc, workspace configuration,
// hooks, packageManager declarations and lifecycle scripts are never executed.
export async function prefetchDependencies(
  cwd: string,
  environment: string,
  signal: AbortSignal,
  execute: (
    file: string,
    args: string[],
    options: ExecFileOptions,
  ) => Promise<unknown> = exec,
): Promise<DependencySetupResult> {
  signal.throwIfAborted();
  const lock = join(cwd, "pnpm-lock.yaml");
  const info = await lstat(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return { status: "skipped" };
  if (!info.isFile())
    throw new Error("Dependency lockfile must be a regular file");
  await Promise.all(
    ["home", "tmp", "runtime", "cache"].map((path) =>
      mkdir(join(environment, path), { recursive: true, mode: 0o700 }),
    ),
  );
  const setup = join(environment, "dependency-setup");
  await mkdir(setup);
  await copyFile(lock, join(setup, "pnpm-lock.yaml"));
  try {
    await execute(
      "/opt/tailos-checks/node_modules/.bin/pnpm",
      [
        "fetch",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--store-dir",
        join(environment, "store"),
        "--registry=https://registry.npmjs.org",
      ],
      {
        cwd: setup,
        signal,
        env: {
          PATH: "/opt/tailos-checks/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
          HOME: join(environment, "home"),
          TMPDIR: join(environment, "tmp"),
          XDG_RUNTIME_DIR: join(environment, "runtime"),
          XDG_CACHE_HOME: join(environment, "cache"),
          NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
          pnpm_config_pm_on_fail: "ignore",
          npm_config_verify_deps_before_run: "false",
          pnpm_config_verify_deps_before_run: "false",
          npm_config_userconfig: "/dev/null",
          npm_config_globalconfig: "/dev/null",
        },
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      },
    );
    return { status: "succeeded" };
  } catch (error) {
    signal.throwIfAborted();
    const parsed = v.safeParse(fetchErrorSchema, error);
    const detail = parsed.success ? parsed.output : undefined;
    const output = [detail?.stderr, detail?.stdout].filter(Boolean).join("\n");
    return {
      status: "failed",
      exitCode:
        typeof detail?.code === "number" && Number.isSafeInteger(detail.code)
          ? detail.code
          : undefined,
      code: typeof detail?.code === "string" ? detail.code : undefined,
      signal: detail?.signal ?? undefined,
      // Keep complete bounded output for RunnerDiagnostics to redact. Never
      // truncate a potential secret before its whole record is scanned.
      output:
        Buffer.byteLength(output) <= 8_192
          ? output
          : "Dependency fetch output omitted: exceeded diagnostic limit",
    };
  }
}

export async function closeDependencyNetwork(
  refresh: { url: string; bearer: string },
  signal: AbortSignal,
  http = fetch,
) {
  const url = new URL("network-closed", refresh.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid network policy URL");
  const response = await http(url, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: "Bearer " + refresh.bearer },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  await response.body?.cancel();
  if (response.status !== 204)
    throw new Error("Dependency network closure failed");
}

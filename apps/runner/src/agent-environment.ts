import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { prepareGitHubCli, trustEnvironment } from "@/egress.ts";

function commandDirectories(root: string) {
  return {
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_CACHE_HOME: join(root, "cache"),
    PNPM_HOME: join(root, "tools"),
  };
}

/** Creates the disposable command directories and gh configuration. */
export async function prepareAgentEnvironment(root: string) {
  const { PNPM_HOME, ...directories } = commandDirectories(root);
  await Promise.all(
    [...Object.values(directories), join(PNPM_HOME, "bin")].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  await prepareGitHubCli(directories.HOME);
}

export function agentCommandEnvironment(root: string) {
  const directories = commandDirectories(root);
  const tools = directories.PNPM_HOME;
  return {
    ...directories,
    npm_config_prefix: tools,
    PATH: [join(tools, "bin"), tools, process.env.PATH].join(delimiter),
    ...trustEnvironment(),
  };
}

/** Package manager and Git defaults for the provider processes. */
export const providerToolEnvironment = {
  npm_config_verify_deps_before_run: "false",
  pnpm_config_verify_deps_before_run: "false",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

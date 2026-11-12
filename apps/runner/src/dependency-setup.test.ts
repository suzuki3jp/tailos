import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { prefetchDependencies } from "@/dependency-setup.ts";

test("setup fetches only the lockfile without running repository config or scripts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tailos-setup-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  const environment = join(root, "environment");
  await mkdir(cwd);
  await mkdir(environment);
  await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(cwd, ".pnpmfile.cjs"), "throw new Error('untrusted')");
  await writeFile(join(cwd, ".npmrc"), "registry=https://evil.example");
  const execute = vi
    .fn<NonNullable<Parameters<typeof prefetchDependencies>[3]>>()
    .mockResolvedValue({ stdout: "", stderr: "" });
  await prefetchDependencies(
    cwd,
    environment,
    AbortSignal.timeout(10_000),
    execute,
  );
  expect(execute).toHaveBeenCalledOnce();
  const [binary, args, options] = execute.mock.calls[0]!;
  expect(binary).toBe("/opt/tailos-checks/node_modules/.bin/pnpm");
  expect(args).toContain("--ignore-scripts");
  expect(args).toContain("--ignore-pnpmfile");
  expect(args).toContain("--registry=https://registry.npmjs.org");
  expect(options).toMatchObject({
    cwd: join(environment, "dependency-setup"),
    env: {
      npm_config_userconfig: "/dev/null",
      npm_config_globalconfig: "/dev/null",
    },
  });
  expect(await readdir(join(environment, "dependency-setup"))).toEqual([
    "pnpm-lock.yaml",
  ]);
  expect(
    await readFile(
      join(environment, "dependency-setup/pnpm-lock.yaml"),
      "utf8",
    ),
  ).toContain("9.0");
});

test("absent locks skip setup and symlinked locks fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tailos-setup-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const execute = vi.fn();
  await prefetchDependencies(root, root, AbortSignal.timeout(10_000), execute);
  expect(execute).not.toHaveBeenCalled();
  await symlink("/etc/passwd", join(root, "pnpm-lock.yaml"));
  await expect(
    prefetchDependencies(root, root, AbortSignal.timeout(10_000), execute),
  ).rejects.toThrow("regular file");
});

test("Agent work requires successful network closure without redirecting credentials", async () => {
  const { closeDependencyNetwork } = await import("@/dependency-setup.ts");
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  const signal = AbortSignal.timeout(10_000);
  const refresh = {
    url: "https://tailos.example/_runner/runs/id/credentials",
    bearer: "lease",
  };
  await closeDependencyNetwork(refresh, signal, http);
  expect(http).toHaveBeenCalledWith(
    new URL("https://tailos.example/_runner/runs/id/network-closed"),
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Bearer lease" },
    }),
  );
  http.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(closeDependencyNetwork(refresh, signal, http)).rejects.toThrow(
    "closure failed",
  );
});

test("fetch failures retain bounded diagnostics while cancellation still aborts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tailos-setup-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const execute = vi.fn().mockRejectedValue(
    Object.assign(new Error("fetch failed"), {
      code: 1,
      stderr: "ERR_PNPM_FETCH_403 Forbidden",
      stdout: "fetching dependencies",
    }),
  );
  async function prefetch(name: string, signal = AbortSignal.timeout(10_000)) {
    const environment = join(root, name);
    await mkdir(environment);
    return prefetchDependencies(root, environment, signal, execute);
  }
  expect(await prefetch("failure")).toEqual({
    status: "failed",
    exitCode: 1,
    output: "ERR_PNPM_FETCH_403 Forbidden\nfetching dependencies",
  });
  expect(execute.mock.lastCall?.[2]).toHaveProperty("timeout", 60_000);
  execute.mockRejectedValueOnce({
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    stderr: "x".repeat(8_193),
  });
  expect(await prefetch("oversized")).toMatchObject({
    status: "failed",
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    output: "Dependency fetch output omitted: exceeded diagnostic limit",
  });
  execute.mockRejectedValueOnce({ code: null, signal: "SIGTERM" });
  expect(await prefetch("terminated")).toMatchObject({
    status: "failed",
    signal: "SIGTERM",
  });
  await expect(prefetch("aborted", AbortSignal.abort())).rejects.toThrow();
});

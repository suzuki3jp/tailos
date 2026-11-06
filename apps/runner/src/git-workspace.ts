import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunnerJob, RunnerPublication } from "@meguri/core/runner";

const exec = promisify(execFile);
type Checkout = NonNullable<
  Extract<RunnerJob, { engine: "codex" }>["checkout"]
>;

export async function runInGitWorkspace(
  checkout: Checkout,
  signal: AbortSignal,
  work: (cwd: string) => Promise<string>,
  remote = `https://github.com/${checkout.repository}.git`,
  beforePush?: (work: {
    branch: string;
    sha: string;
    reply: string;
  }) => Promise<void>,
): Promise<{ reply: string; publication: RunnerPublication }> {
  const metadata = await mkdtemp(
    join(process.env.MEGURI_GIT_STATE_DIR ?? tmpdir(), "meguri-git-"),
  );
  const cwd = await mkdtemp(join(tmpdir(), "meguri-repo-")).catch(
    async (error) => {
      await rm(metadata, { recursive: true, force: true });
      throw error;
    },
  );
  const baseEnv = {
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Meguri",
    GIT_AUTHOR_EMAIL: "meguri[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Meguri",
    GIT_COMMITTER_EMAIL: "meguri[bot]@users.noreply.github.com",
  };
  const git = async (args: string[], network = false) => {
    const env = network
      ? {
          ...baseEnv,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0:
            "Authorization: Basic " +
            Buffer.from("x-access-token:" + checkout.token).toString("base64"),
        }
      : baseEnv;
    try {
      return (
        await exec(
          "git",
          [
            "--git-dir=" + metadata,
            "--work-tree=" + cwd,
            "--no-pager",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "credential.helper=",
            "-c",
            "http.proxy=",
            "-c",
            "http.sslVerify=true",
            "-c",
            "http.followRedirects=false",
            ...args,
          ],
          { cwd, env, signal, maxBuffer: 1024 * 1024 },
        )
      ).stdout.trim();
    } catch {
      // Git errors can carry transport headers or private repository data.
      throw new Error("Repository operation failed");
    }
  };
  try {
    await git(["init", "--quiet"]);
    await writeFile(join(cwd, ".git"), `gitdir: ${metadata}\n`, { flag: "wx" });
    await git(
      [
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "--no-tags",
        remote,
        checkout.baseSha,
      ],
      true,
    );
    await git(["checkout", "--quiet", "--detach", checkout.baseSha]);
    const configPath = join(metadata, "config");
    const trustedConfig = await readFile(configPath);
    const reply = await work(cwd);
    if (!(await readFile(configPath)).equals(trustedConfig))
      throw new Error("Git metadata configuration changed");
    await git(["add", "--all"]);
    const changes = await git([
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
    if (changes)
      await git([
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        "Implement GitHub issue",
      ]);
    await git(["merge-base", "--is-ancestor", checkout.baseSha, "HEAD"]);
    const changedPaths = await git([
      "diff",
      "--no-ext-diff",
      "--name-only",
      checkout.baseSha,
      "HEAD",
    ]);
    if (!changedPaths) return { reply, publication: { kind: "no_changes" } };
    const sha = await git(["rev-parse", "HEAD"]);
    await beforePush?.({ branch: checkout.branch, sha, reply });
    signal.throwIfAborted();
    await git(
      ["push", "--quiet", remote, `${sha}:refs/heads/${checkout.branch}`],
      true,
    );
    return {
      reply,
      publication: { kind: "pushed", branch: checkout.branch, sha },
    };
  } finally {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(metadata, { recursive: true, force: true }),
    ]);
  }
}

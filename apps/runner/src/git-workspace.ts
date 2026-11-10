import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import {
  changeHeadline,
  maxPublicationBytes,
  type CheckedPublication,
  type FileChanges,
  type RunnerJob,
  type RunnerPublication,
} from "@meguri/core/runner";
import * as v from "valibot";
import { PublicationFailed, type AgentResult } from "./agent.ts";

const exec = promisify(execFile);
type Checkout = NonNullable<
  Extract<RunnerJob, { engine: "codex" }>["checkout"]
>;
type CheckedWork = Omit<CheckedPublication, "kind" | "events">;

export async function runInGitWorkspace(
  checkout: Checkout,
  signal: AbortSignal,
  work: (cwd: string) => Promise<AgentResult>,
  check: (cwd: string) => Promise<void>,
  stage: (work: CheckedWork) => Promise<void>,
  remote = `https://github.com/${checkout.repository}.git`,
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
          {
            cwd,
            env,
            signal,
            maxBuffer: maxPublicationBytes,
            encoding: "buffer",
          },
        )
      ).stdout;
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
    const readScripts = (manifest: Buffer) =>
      v.parse(
        v.object({ scripts: v.optional(v.record(v.string(), v.string()), {}) }),
        JSON.parse(manifest.toString()),
      ).scripts;
    const baseScripts = await git(["show", checkout.baseSha + ":package.json"])
      .then(readScripts)
      .catch(() => null);
    const configPath = join(metadata, "config");
    const trustedConfig = await readFile(configPath);
    const { reply, headline } = await work(cwd);
    if (!(await readFile(configPath)).equals(trustedConfig))
      throw new Error("Git metadata configuration changed");

    await git(["read-tree", checkout.baseSha]);
    await git(["add", "--all"]);
    const tree = (await git(["write-tree"])).toString().trim();
    const paths = await git([
      "diff-tree",
      "-r",
      "-z",
      "--raw",
      "--no-renames",
      checkout.baseSha,
      tree,
    ]);
    if (!paths.length) return { reply, publication: { kind: "no_changes" } };
    const validatedHeadline = v.safeParse(changeHeadline, headline);
    if (!validatedHeadline.success)
      throw new PublicationFailed("invalid_change_headline");

    const changes: FileChanges = { additions: [], deletions: [] };
    const entries = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(paths)
      .split("\0");
    let size = 0;
    for (let i = 0; i < entries.length - 1; i += 2) {
      const [oldMode, newMode, , oid, status] = entries[i]!.slice(1).split(" ");
      const path = entries[i + 1]!;
      if (path.split("/").includes("node_modules") || i >= 1024)
        throw new PublicationFailed("unsupported_changes");
      if (status === "D") {
        changes.deletions.push({ path });
        continue;
      }
      // GitHub preserves the mode of an existing regular file and creates new files as 100644.
      const supported =
        status === "A"
          ? newMode === "100644"
          : oldMode === newMode &&
            (newMode === "100644" || newMode === "100755");
      if (!supported) throw new PublicationFailed("unsupported_changes");
      const contents = (await git(["cat-file", "blob", oid!])).toString(
        "base64",
      );
      size += contents.length;
      if (size >= maxPublicationBytes)
        throw new PublicationFailed("unsupported_changes");
      changes.additions.push({ path, contents });
    }

    // Check a fresh checkout of the staged snapshot. Untracked build output and
    // dependencies installed or modified by the Agent cannot affect the checks.
    const verification = await mkdtemp(join(tmpdir(), "meguri-check-"));
    try {
      await git(["checkout-index", "--all", "--prefix=" + verification + sep]);
      const scripts = await readFile(join(verification, "package.json"))
        .then(readScripts)
        .catch(() => null);
      if (
        !baseScripts?.["format:check"] ||
        baseScripts["format:check"] !== scripts?.["format:check"]
      )
        throw new PublicationFailed("format_check_failed");
      if (!baseScripts.lint || baseScripts.lint !== scripts?.lint)
        throw new PublicationFailed("lint_failed");
      await check(verification);
    } finally {
      await rm(verification, { recursive: true, force: true });
    }

    signal.throwIfAborted();
    await stage({
      branch: checkout.branch,
      baseSha: checkout.baseSha,
      tree,
      headline: validatedHeadline.output,
      reply,
      changes,
    });
    return { reply, publication: { kind: "checked" } };
  } finally {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(metadata, { recursive: true, force: true }),
    ]);
  }
}

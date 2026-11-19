import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  changeHeadline,
  maxPublicationBytes,
  type CheckedPublication,
  type FileChanges,
  type RunnerJob,
  type RunnerPublication,
} from "@tailos/core/runner";
import * as v from "valibot";
import type { Diagnostics } from "@tailos/core/diagnostics";
import { PublicationFailed, type AgentResult } from "@/agent.ts";
import {
  diagnosticErrorBody,
  systemErrorDetails,
  withDiagnosticSpan,
} from "@/diagnostic-operations.ts";

const exec = promisify(execFile);
type Checkout = NonNullable<
  Extract<RunnerJob, { engine: "codex" }>["checkout"]
>;
type CheckedWork = Omit<CheckedPublication, "kind" | "events">;

export async function runInGitWorkspace(
  checkout: Checkout,
  signal: AbortSignal,
  work: (cwd: string) => Promise<AgentResult>,
  stage: (work: CheckedWork) => Promise<void>,
  remote = `https://github.com/${checkout.repository}.git`,
  diagnostics?: Diagnostics,
  mode?: RunnerJob["mode"],
): Promise<{
  reply: string;
  sessionTitle?: string;
  publication?: RunnerPublication;
  plan?: AgentResult["plan"];
}> {
  const metadata = await mkdtemp(
    join(process.env.TAILOS_GIT_STATE_DIR ?? tmpdir(), "tailos-git-"),
  );
  const cwd = await mkdtemp(join(tmpdir(), "tailos-repo-")).catch(
    async (error) => {
      await withDiagnosticSpan(
        diagnostics,
        "cleanup",
        () => rm(metadata, { recursive: true, force: true }),
        JSON.stringify({ target: "git_metadata" }),
      );
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
    } catch (error) {
      // Git errors can carry transport headers or private repository data.
      throw Object.assign(
        new Error(`Repository operation failed: git ${args[0]}`),
        systemErrorDetails(error),
      );
    }
  };
  let activeSpan: string | undefined;
  try {
    activeSpan = diagnostics?.start(
      "checkout",
      JSON.stringify({
        repository: checkout.repository,
        baseSha: checkout.baseSha,
        branch: checkout.branch,
      }),
    );
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
    if (activeSpan) diagnostics?.end(activeSpan);
    activeSpan = undefined;
    const configPath = join(metadata, "config");
    const trustedConfig = await readFile(configPath);
    const { reply, headline, plan, sessionTitle } = await work(cwd);
    const title = sessionTitle ? { sessionTitle } : {};
    signal.throwIfAborted();
    if (mode === "plan") {
      if (!plan) throw new Error("Missing plan result");
      return { reply, plan, ...title };
    }
    activeSpan = diagnostics?.start("workspace");
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
    if (!paths.length) {
      if (activeSpan) diagnostics?.end(activeSpan, {}, "no_changes");
      activeSpan = undefined;
      return { reply, publication: { kind: "no_changes" }, ...title };
    }
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

    signal.throwIfAborted();
    if (activeSpan)
      diagnostics?.end(
        activeSpan,
        {},
        JSON.stringify({
          additions: changes.additions.map((file) => file.path),
          deletions: changes.deletions.map((file) => file.path),
          tree,
        }),
      );
    activeSpan = diagnostics?.start("publication");
    await stage({
      branch: checkout.branch,
      baseSha: checkout.baseSha,
      tree,
      headline: validatedHeadline.output,
      reply,
      changes,
      ...title,
    });
    if (activeSpan) diagnostics?.end(activeSpan);
    activeSpan = undefined;
    return { reply, publication: { kind: "checked" }, ...title };
  } catch (error) {
    if (activeSpan)
      diagnostics?.end(
        activeSpan,
        { outcome: "failed" },
        diagnosticErrorBody(error),
      );
    throw error;
  } finally {
    const cleanup = [
      withDiagnosticSpan(
        diagnostics,
        "cleanup",
        () => rm(cwd, { recursive: true, force: true }),
        JSON.stringify({ target: "workspace" }),
      ),
      withDiagnosticSpan(
        diagnostics,
        "cleanup",
        () => rm(metadata, { recursive: true, force: true }),
        JSON.stringify({ target: "git_metadata" }),
      ),
    ];
    // Finish both cleanup spans before the server flushes final diagnostics.
    await Promise.all(cleanup).catch(async (error: unknown) => {
      await Promise.allSettled(cleanup);
      throw error;
    });
  }
}

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  changeHeadline,
  continuitySaveMs,
  maxPublicationBytes,
  type CheckedPublication,
  type FileChanges,
  type RunnerJob,
  type RunnerPublication,
} from "@tailos/core/runner";
import * as v from "valibot";
import type { Diagnostics } from "@tailos/core/diagnostics";
import {
  PublicationFailed,
  type AgentResult,
  type Conversation,
} from "@/agent.ts";
import {
  ContinuityTooLarge,
  decodeSavedWork,
  encodeSavedWork,
  type SavedConversation,
} from "@/continuity.ts";
import { trustEnvironment } from "@/egress.ts";
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

/** What the previous Turn left, and where this Turn's saved work goes. */
export type WorkspaceContinuity = {
  restore?: Buffer | "lost";
  saved(
    result:
      | { archive: Buffer }
      | { skipped: true }
      | { failed: "too_large" | "error" },
  ): void;
};

const continuityRef = "refs/tailos/continuity";
// The saved work commit is never published, only carried to the next Turn.
const continuityIdentity = {
  GIT_AUTHOR_NAME: "Tailos",
  GIT_AUTHOR_EMAIL: "tailos@localhost",
  GIT_COMMITTER_NAME: "Tailos",
  GIT_COMMITTER_EMAIL: "tailos@localhost",
};

export async function runInGitWorkspace(
  checkout: Checkout,
  signal: AbortSignal,
  work: (cwd: string, conversation?: Conversation) => Promise<AgentResult>,
  stage: (work: CheckedWork) => Promise<void>,
  remote = `https://github.com/${checkout.repository}.git`,
  diagnostics?: Diagnostics,
  mode?: RunnerJob["mode"],
  continuity?: WorkspaceContinuity,
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
  // No credentials here: GitHub requests get the Run's token outside the
  // container, and only the CA for that interception is added.
  const env = {
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...trustEnvironment(),
  };
  const git = async (
    args: string[],
    options: { env?: Record<string, string>; signal?: AbortSignal } = {},
  ) => {
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
            env: { ...env, ...options.env },
            signal: options.signal ?? signal,
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
  const configPath = join(metadata, "config");
  let trustedConfig: Buffer | undefined;
  let agentStarted = false;
  let savedConversation: SavedConversation | undefined;

  /** Puts the previous Turn's commits and work tree on top of its base. */
  const restore = async (archive: Buffer) => {
    const saved = await decodeSavedWork(archive);
    if (saved.baseSha !== checkout.baseSha)
      throw new Error("Saved work has another base");
    const bundle = join(metadata, "tailos-continuity.bundle");
    await writeFile(bundle, saved.bundle);
    await git([
      "fetch",
      "--quiet",
      "--no-tags",
      bundle,
      `${continuityRef}:${continuityRef}`,
    ]);
    await rm(bundle, { force: true });
    const parent = (await git(["rev-parse", `${saved.work}^`])).toString();
    if (parent.trim() !== saved.head)
      throw new Error("Saved work does not follow its HEAD");
    await git(["merge-base", "--is-ancestor", checkout.baseSha, saved.head]);
    await git(["checkout", "--quiet", "--detach", saved.head]);
    // Bring the work tree to the saved one, then leave those changes
    // unstaged as they were.
    await git(["read-tree", "-m", "-u", saved.head, saved.work]);
    await git(["reset", "--quiet"]);
    await git(["update-ref", "-d", continuityRef]);
    return saved.conversation;
  };

  /** Hands this Turn's work to the controller; never fails the Turn. */
  const save = async () => {
    if (!continuity) return;
    // Nothing ran on the previous Turn's work, which therefore stays current.
    if (!agentStarted || !trustedConfig) {
      continuity.saved({ skipped: true });
      return;
    }
    const saveSignal = AbortSignal.timeout(continuitySaveMs);
    const index = { GIT_INDEX_FILE: join(metadata, "tailos-continuity-index") };
    try {
      if (!(await readFile(configPath)).equals(trustedConfig))
        throw new Error("Git metadata configuration changed");
      const head = (await git(["rev-parse", "HEAD"], { signal: saveSignal }))
        .toString()
        .trim();
      await git(["read-tree", head], { env: index, signal: saveSignal });
      await git(["add", "--all"], { env: index, signal: saveSignal });
      const tree = (
        await git(["write-tree"], { env: index, signal: saveSignal })
      )
        .toString()
        .trim();
      const work = (
        await git(
          ["commit-tree", tree, "-p", head, "-m", "Tailos saved work"],
          {
            env: continuityIdentity,
            signal: saveSignal,
          },
        )
      )
        .toString()
        .trim();
      await git(["update-ref", continuityRef, work], { signal: saveSignal });
      const bundle = join(metadata, "tailos-continuity.bundle");
      await git(
        ["bundle", "create", bundle, continuityRef, `^${checkout.baseSha}`],
        { signal: saveSignal },
      );
      continuity.saved({
        archive: await encodeSavedWork({
          baseSha: checkout.baseSha,
          head,
          work,
          bundle: await readFile(bundle),
          ...(savedConversation && { conversation: savedConversation }),
        }),
      });
    } catch (error) {
      continuity.saved({
        failed: error instanceof ContinuityTooLarge ? "too_large" : "error",
      });
      const span = diagnostics?.start(
        "continuity",
        JSON.stringify({ target: "save" }),
      );
      if (span)
        diagnostics?.end(
          span,
          { outcome: "failed" },
          diagnosticErrorBody(error),
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
    await git([
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "--no-tags",
      remote,
      checkout.baseSha,
    ]);
    await git(["checkout", "--quiet", "--detach", checkout.baseSha]);
    if (activeSpan) diagnostics?.end(activeSpan);
    activeSpan = undefined;
    let conversation: Conversation | undefined;
    if (continuity) {
      let resume: SavedConversation | undefined;
      let lost = continuity.restore === "lost";
      if (Buffer.isBuffer(continuity.restore)) {
        activeSpan = diagnostics?.start("continuity");
        try {
          resume = await restore(continuity.restore);
          if (activeSpan)
            diagnostics?.end(
              activeSpan,
              {},
              JSON.stringify({ restored: true }),
            );
        } catch (error) {
          lost = true;
          // Start again from the base, without what the restore left behind.
          await git([
            "checkout",
            "--quiet",
            "--force",
            "--detach",
            checkout.baseSha,
          ]);
          await git(["clean", "--quiet", "-d", "--force", "-x"]);
          if (activeSpan)
            diagnostics?.end(
              activeSpan,
              { outcome: "failed" },
              diagnosticErrorBody(error),
            );
        }
        activeSpan = undefined;
      } else if (lost) {
        // The previous Turn's work was not saved: the user sees it here.
        const span = diagnostics?.start("continuity");
        if (span)
          diagnostics?.end(
            span,
            { outcome: "failed" },
            JSON.stringify({ restored: false }),
          );
      }
      // Until the Agent hands over a newer one, the conversation stays as it was.
      savedConversation = resume;
      conversation = {
        ...(resume && { resume }),
        ...(lost && { lost: true }),
        save: (saved) => {
          savedConversation = saved;
        },
      };
    }
    trustedConfig = await readFile(configPath);
    agentStarted = true;
    const { reply, headline, plan, sessionTitle } = await work(
      cwd,
      conversation,
    );
    const title = sessionTitle ? { sessionTitle } : {};
    signal.throwIfAborted();
    if (mode === "plan") {
      if (!plan) throw new Error("Missing plan result");
      return { reply, plan, ...title };
    }
    activeSpan = diagnostics?.start("workspace");
    if (!(await readFile(configPath)).equals(trustedConfig!))
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
    await save();
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

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { continuitySaveMs, type RunnerJob } from "@tailos/core/runner";
import type { Diagnostics } from "@tailos/core/diagnostics";
import type { AgentResult, Conversation } from "@/agent.ts";
import {
  ContinuityTooLarge,
  decodeSavedWork,
  encodeSavedWork,
  keptRef,
  maxSavedRefs,
  type SavedConversation,
  type SavedWork,
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

/**
 * What the previous Turn left, and where this Turn's saved work goes. With a
 * `workDir`, the work tree stays there after the Turn, so that a container
 * restored from a snapshot, or kept waiting, finds it in place.
 */
export type WorkspaceContinuity = {
  restore?: Buffer | "lost";
  workDir?: string;
  saved(
    result:
      | { archive: Buffer }
      | { skipped: true }
      | { failed: "too_large" | "error" },
  ): void;
};

/** Where the Agent's work tree and its git directory are. */
export type Workspace = { cwd: string; gitDir: string };

const continuityRef = "refs/tailos/continuity";
const remoteRef = (name: string) => name.startsWith("refs/remotes/");
/** Where a restore puts the saved commits before the branches move to them. */
const restorePrefix = "refs/tailos/restore/";
/** The output git commands may print, such as a list of many branches. */
const maxOutputBytes = 16 * 1024 * 1024;
const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
// The saved work commit is never pushed, only carried to the next Turn.
const continuityIdentity = {
  GIT_AUTHOR_NAME: "Tailos",
  GIT_AUTHOR_EMAIL: "tailos@localhost",
  GIT_COMMITTER_NAME: "Tailos",
  GIT_COMMITTER_EMAIL: "tailos@localhost",
};

/**
 * The commits a bundle needs but does not carry, from its header: the lines
 * after the signature that start with `-`, before the first empty line.
 */
export function bundlePrerequisites(bundle: Buffer) {
  const end = bundle.indexOf("\n\n");
  if (end < 0) throw new Error("Invalid bundle");
  const lines = bundle.subarray(0, end).toString("utf8").split("\n");
  if (!/^# v[23] git bundle$/.test(lines[0] ?? ""))
    throw new Error("Invalid bundle");
  return lines
    .slice(1)
    .filter((line) => line.startsWith("-"))
    .map((line) => {
      const sha = /^-([a-f0-9]{40})(?: |$)/.exec(line)?.[1];
      if (!sha) throw new Error("Invalid bundle");
      return sha;
    });
}

/**
 * Prepares the Session's work tree, runs the Agent in it, and saves the work
 * for the next Turn. The Agent owns the repository: it may commit, switch and
 * create branches, change the git configuration and push. The Runner's own git
 * commands never read the Agent's configuration.
 */
export async function runInGitWorkspace(
  checkout: Checkout,
  signal: AbortSignal,
  work: (
    workspace: Workspace,
    conversation?: Conversation,
  ) => Promise<AgentResult>,
  remote = `https://github.com/${checkout.repository}.git`,
  diagnostics?: Diagnostics,
  mode?: RunnerJob["mode"],
  continuity?: WorkspaceContinuity,
): Promise<{
  reply: string;
  sessionTitle?: string;
  plan?: AgentResult["plan"];
}> {
  const workDir = continuity?.workDir;
  const metadata = workDir
    ? join(workDir, "git")
    : await mkdtemp(
        join(process.env.TAILOS_GIT_STATE_DIR ?? tmpdir(), "tailos-git-"),
      );
  const cwd = workDir
    ? join(workDir, "repo")
    : await mkdtemp(join(tmpdir(), "tailos-repo-")).catch(async (error) => {
        await withDiagnosticSpan(
          diagnostics,
          "cleanup",
          () => rm(metadata, { recursive: true, force: true }),
          JSON.stringify({ target: "git_metadata" }),
        );
        throw error;
      });
  // No credentials here: GitHub requests get the Run's token outside the
  // container, and only the CA for that interception is added.
  const env = {
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...trustEnvironment(),
  };
  const run = async (
    args: string[],
    options: {
      env?: Record<string, string>;
      signal?: AbortSignal;
      cwd?: string;
    } = {},
  ) => {
    try {
      return (
        await exec("git", args, {
          cwd: options.cwd ?? cwd,
          env: { ...env, ...options.env },
          signal: options.signal ?? signal,
          maxBuffer: maxOutputBytes,
          encoding: "buffer",
        })
      ).stdout;
    } catch (error) {
      // Git errors can carry transport headers or private repository data.
      throw Object.assign(
        new Error(`Repository operation failed: git ${args[0]}`),
        systemErrorDetails(error),
      );
    }
  };
  const git = (
    args: string[],
    options: { env?: Record<string, string>; signal?: AbortSignal } = {},
  ) =>
    run(
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
      options,
    );
  const text = async (
    args: string[],
    options: { env?: Record<string, string>; signal?: AbortSignal } = {},
  ) => (await git(args, options)).toString().trim();
  const configPath = join(metadata, "config");
  // The Agent writes the git directory: the Runner's own files go elsewhere.
  const scratch = await mkdtemp(
    join(process.env.TAILOS_GIT_STATE_DIR ?? tmpdir(), "tailos-runner-"),
  );

  /**
   * The Agent's git configuration as it is, or undefined when it is not a
   * regular file. Links are not followed: they could point anywhere.
   */
  const readConfig = async () => {
    const file = await open(
      configPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => undefined);
    if (!file) return undefined;
    try {
      return (await file.stat()).isFile() ? await file.readFile() : undefined;
    } finally {
      await file.close();
    }
  };
  /** Replaces the configuration without writing through a link. */
  const writeConfig = async (data: Buffer) => {
    await rm(configPath, { force: true });
    await writeFile(configPath, data, { flag: "wx" });
  };

  /**
   * The configuration the Runner's git commands use: a clone's, with the
   * GitHub App's bot as the author. The Agent starts with it too.
   */
  const runnerConfig = await (async () => {
    // The work tree may not exist yet.
    const outside = { cwd: tmpdir() };
    const valid = await run(
      ["check-ref-format", "--branch", checkout.defaultBranch],
      outside,
    ).then(
      (name) => name.toString().trim() === checkout.defaultBranch,
      () => false,
    );
    if (!valid) throw new Error("Invalid default branch");
    const directory = await mkdtemp(join(tmpdir(), "tailos-config-"));
    try {
      const file = join(directory, "config");
      const set = (key: string, value: string) =>
        run(["config", "--file", file, key, value], outside);
      await set("core.repositoryformatversion", "0");
      await set("core.filemode", "true");
      await set("core.bare", "false");
      await set("core.logallrefupdates", "true");
      await set("remote.origin.url", remote);
      await set("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      await set(`branch.${checkout.defaultBranch}.remote`, "origin");
      await set(
        `branch.${checkout.defaultBranch}.merge`,
        `refs/heads/${checkout.defaultBranch}`,
      );
      await set("user.name", checkout.author.name);
      await set("user.email", checkout.author.email);
      return await readFile(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();

  /**
   * Makes the Runner's git commands safe to run on a git directory the Agent
   * may have changed: they read the Runner's configuration, and nothing
   * outside the git directory. Returns what the Agent's configuration was.
   */
  const asRunner = async () => {
    const own = await stat(join(metadata, "commondir")).then(
      () => false,
      () => true,
    );
    if (!own) throw new Error("Git metadata refers to another directory");
    const agentConfig = await readConfig();
    await writeConfig(runnerConfig);
    return agentConfig;
  };

  /** The tree of the whole work tree on HEAD, without touching the index. */
  const workTree = async (head: string, options: { signal?: AbortSignal }) => {
    const index = { GIT_INDEX_FILE: join(scratch, "index") };
    try {
      await git(["read-tree", head], { ...options, env: index });
      await git(["add", "--all"], { ...options, env: index });
      return await text(["write-tree"], { ...options, env: index });
    } finally {
      await rm(index.GIT_INDEX_FILE, { force: true });
    }
  };

  /**
   * The references the Session keeps, sorted by name: branches, the remote's
   * branches as last seen, and older kept work. A remote's symbolic HEAD is
   * left out.
   */
  const keptRefs = async (options: { signal?: AbortSignal } = {}) => {
    const output = await text(
      [
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/heads/",
        "refs/remotes/",
        keptRef,
      ],
      options,
    );
    const refs = (output ? output.split("\n") : [])
      .map((line) => ({ name: line.slice(41), sha: line.slice(0, 40) }))
      .filter(({ name }) => !/^refs\/remotes\/[^/]+\/HEAD$/.test(name));
    if (refs.length > maxSavedRefs) throw new ContinuityTooLarge();
    return refs.sort((a, b) => (a.name < b.name ? -1 : 1));
  };

  /** The local branch HEAD is on, or undefined when it is detached. */
  const headBranch = (options: { signal?: AbortSignal } = {}) =>
    text(["symbolic-ref", "--quiet", "HEAD"], options).then(
      (name) => name || undefined,
      () => undefined,
    );

  /**
   * Whether the work tree in place is exactly the saved work: same HEAD,
   * branches, files and git configuration. Runs as the Runner.
   */
  const matchesInPlace = async (saved: SavedWork, agentConfig?: Buffer) => {
    try {
      if (!saved.gitConfig || !agentConfig) return false;
      if (digest(agentConfig) !== digest(saved.gitConfig)) return false;
      if ((await text(["rev-parse", "HEAD"])) !== saved.head) return false;
      if ((await headBranch()) !== saved.branch) return false;
      const names = (refs: SavedWork["refs"]) =>
        refs.map(({ name, sha }) => `${sha} ${name}`).join("\n");
      if (names(await keptRefs()) !== names(saved.refs)) return false;
      const tree = await text([
        "rev-parse",
        "--verify",
        `${saved.work}^{tree}`,
      ]);
      return (await workTree(saved.head, {})) === tree;
    } catch {
      return false;
    }
  };

  /**
   * Fetches a commit of the target repository unless it is already here;
   * `shallow` fetches it without its history.
   */
  const ensureCommit = async (sha: string, shallow = false) => {
    const present = await git(["cat-file", "-e", `${sha}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!present)
      await git([
        "fetch",
        "--quiet",
        "--no-tags",
        ...(shallow ? ["--depth", "1"] : []),
        remote,
        sha,
      ]);
  };

  /** An empty repository with the Runner's configuration. */
  const initialize = async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(metadata, { recursive: true, force: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(metadata, { recursive: true });
    await git(["init", "--quiet"]);
    await writeConfig(runnerConfig);
    await writeFile(join(cwd, ".git"), `gitdir: ${metadata}\n`, {
      flag: "wx",
    });
  };

  /** The start of a Session: like a shallow clone of the default branch. */
  const start = async () => {
    await ensureCommit(checkout.baseSha, true);
    await git([
      "checkout",
      "--quiet",
      "--force",
      "-B",
      checkout.defaultBranch,
      checkout.baseSha,
    ]);
    await git([
      "update-ref",
      `refs/remotes/origin/${checkout.defaultBranch}`,
      checkout.baseSha,
    ]);
  };

  /**
   * Puts the previous Turn's branches, HEAD and work tree back on top of its
   * base. The commits the bundle needs come from the target repository.
   */
  const restore = async (saved: SavedWork) => {
    if (saved.baseSha !== checkout.baseSha)
      throw new Error("Saved work has another base");
    const prerequisites = bundlePrerequisites(saved.bundle);
    if (prerequisites.length > maxSavedRefs)
      throw new Error("Saved work needs too many commits");
    await start();
    for (const sha of prerequisites) await ensureCommit(sha, true);
    const bundle = join(scratch, "restore.bundle");
    await writeFile(bundle, saved.bundle);
    try {
      await git([
        "fetch",
        "--quiet",
        "--no-tags",
        bundle,
        `+refs/*:${restorePrefix}*`,
      ]);
    } finally {
      await rm(bundle, { force: true });
    }
    if ((await text(["rev-parse", `${saved.work}^`])) !== saved.head)
      throw new Error("Saved work does not follow its HEAD");
    await git(["checkout", "--quiet", "--force", "--detach", saved.head]);
    // Branches the Agent no longer has, such as the default branch, go.
    for (const ref of await keptRefs())
      if (!saved.refs.some((kept) => kept.name === ref.name))
        await git(["update-ref", "-d", ref.name]);
    for (const ref of saved.refs) {
      const present = await git(["cat-file", "-e", `${ref.sha}^{commit}`]).then(
        () => true,
        () => false,
      );
      // The remote's branches are only what was last fetched: one whose
      // commits are not carried stays as the base has it, until a fetch.
      if (!present && remoteRef(ref.name)) continue;
      if (!present) throw new Error("Saved branch is missing its commit");
      await git(["update-ref", ref.name, ref.sha]);
    }
    // Bring the work tree to the saved one, then leave those changes
    // unstaged as they were.
    await git(["read-tree", "-m", "-u", saved.head, saved.work]);
    await git(["reset", "--quiet"]);
    if (saved.branch) {
      if ((await text(["rev-parse", "--verify", saved.branch])) !== saved.head)
        throw new Error("Saved HEAD is not on its branch");
      await git(["symbolic-ref", "HEAD", saved.branch]);
    }
    const restored = await text([
      "for-each-ref",
      "--format=%(refname)",
      restorePrefix,
    ]);
    for (const name of restored ? restored.split("\n") : [])
      await git(["update-ref", "-d", name]);
    return saved.conversation;
  };

  /** Hands this Turn's work to the controller; never fails the Turn. */
  let agentStarted = false;
  let savedConversation: SavedConversation | undefined;
  const save = async () => {
    if (!continuity) return;
    // Nothing ran on the previous Turn's work, which therefore stays current.
    if (!agentStarted) {
      continuity.saved({ skipped: true });
      return;
    }
    const saveSignal = AbortSignal.timeout(continuitySaveMs);
    const options = { signal: saveSignal };
    let agentConfig: Buffer | undefined;
    try {
      agentConfig = await asRunner();
      // A branch without commits yet has no HEAD: its files are kept as
      // changes on the base, without the branch.
      const born = await text(
        ["rev-parse", "--verify", "--quiet", "HEAD"],
        options,
      ).catch(() => undefined);
      const head = born || checkout.baseSha;
      const branch = born ? await headBranch(options) : undefined;
      const refs = await keptRefs(options);
      const tree = await workTree(head, options);
      const work = await text(
        ["commit-tree", tree, "-p", head, "-m", "Tailos saved work"],
        { env: continuityIdentity, signal: saveSignal },
      );
      await git(["update-ref", continuityRef, work], options);
      // History before the base or a shallow fetch's boundary is not here:
      // the next Turn fetches those commits again.
      const shallow = await readFile(join(metadata, "shallow"), "utf8").then(
        (data) =>
          data.split("\n").filter((line) => /^[a-f0-9]{40}$/.test(line)),
        () => [],
      );
      const bundle = join(scratch, "save.bundle");
      try {
        await git(
          [
            "bundle",
            "create",
            bundle,
            continuityRef,
            // The remote's branches stay out: their history can be long, and
            // it is on GitHub.
            ...refs
              .filter((ref) => !remoteRef(ref.name))
              .map((ref) => ref.name),
            "--not",
            checkout.baseSha,
            ...shallow,
          ],
          options,
        );
        continuity.saved({
          archive: await encodeSavedWork({
            baseSha: checkout.baseSha,
            head,
            work,
            ...(branch && { branch }),
            refs,
            ...(agentConfig && { gitConfig: agentConfig }),
            bundle: await readFile(bundle),
            ...(savedConversation && { conversation: savedConversation }),
          }),
        });
      } finally {
        await rm(bundle, { force: true });
        await git(["update-ref", "-d", continuityRef]).catch(() => {});
      }
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
    } finally {
      // A container kept for the next Turn has the Agent's settings in place.
      if (agentConfig) await writeConfig(agentConfig).catch(() => {});
    }
  };

  // The previous Turn's saved work, read once for both ways of restoring it.
  let saved: SavedWork | undefined;
  let unreadable: unknown;
  if (Buffer.isBuffer(continuity?.restore))
    saved = await decodeSavedWork(continuity.restore).catch((error) => {
      unreadable = error;
      return undefined;
    });

  let activeSpan: string | undefined;
  try {
    // A container kept or restored from a snapshot may already hold the work.
    let inPlace = false;
    if (saved && workDir) {
      const agentConfig = await asRunner().catch(() => undefined);
      inPlace = await matchesInPlace(saved, agentConfig);
    }
    // What the Agent starts with: its own settings, or the Runner's.
    let agentConfig: Buffer = runnerConfig;
    let conversation: Conversation | undefined;
    if (!inPlace) {
      activeSpan = diagnostics?.start(
        "checkout",
        JSON.stringify({
          repository: checkout.repository,
          baseSha: checkout.baseSha,
        }),
      );
      await initialize();
      if (!saved) await start();
      if (activeSpan) diagnostics?.end(activeSpan);
      activeSpan = undefined;
    }
    if (continuity) {
      let resume: SavedConversation | undefined;
      let lost = continuity.restore === "lost";
      if (Buffer.isBuffer(continuity.restore)) {
        activeSpan = diagnostics?.start("continuity");
        try {
          if (!saved) throw unreadable;
          if (!inPlace) await restore(saved);
          resume = saved.conversation;
          if (saved.gitConfig) agentConfig = saved.gitConfig;
          if (activeSpan)
            diagnostics?.end(
              activeSpan,
              {},
              JSON.stringify({ restored: true, inPlace }),
            );
        } catch (error) {
          lost = true;
          // Start again from the base, without what the restore left.
          await initialize();
          await start();
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
    await writeConfig(agentConfig);
    agentStarted = true;
    const { reply, plan, sessionTitle } = await work(
      { cwd, gitDir: metadata },
      conversation,
    );
    const title = sessionTitle ? { sessionTitle } : {};
    signal.throwIfAborted();
    if (mode === "plan") {
      if (!plan) throw new Error("Missing plan result");
      return { reply, plan, ...title };
    }
    return { reply, ...title };
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
    await rm(scratch, { recursive: true, force: true });
    // The work stays for a snapshot or the Session's next Turn.
    const cleanup = workDir
      ? []
      : [
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

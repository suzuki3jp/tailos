import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi, type TestContext } from "vitest";
import {
  bundlePrerequisites,
  runInGitWorkspace,
  type Workspace,
  type WorkspaceContinuity,
} from "@/git-workspace.ts";
import { decodeSavedWork } from "@/continuity.ts";
import {
  parseDiagnosticBatch,
  type Diagnostics,
} from "@tailos/core/diagnostics";
import { RunnerDiagnostics } from "@/diagnostics.ts";

// Each Turn runs real git commands, several Turns to a test: slower machines
// such as CI need more than the default time.
vi.setConfig({ testTimeout: 30_000 });

const author = {
  name: "tailos-app[bot]",
  email: "123+tailos-app[bot]@users.noreply.github.com",
};
const identity = ["-c", "user.name=Seed", "-c", "user.email=seed@example.test"];

function gitIn(
  cwd: string,
  env: Record<string, string>,
  input: Buffer | undefined,
  ...args: string[]
) {
  return execFileSync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...env,
    },
    encoding: "utf8",
    ...(input && { input }),
  }).trim();
}

/** Runs git in the Agent's work tree, as the Agent's commands do. */
const agentGit = (cwd: string, ...args: string[]) =>
  gitIn(cwd, {}, undefined, ...args);

async function repository(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "tailos-git-test-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const seed = join(directory, "seed");
  const git = (...args: string[]) => gitIn(seed, {}, undefined, ...args);

  gitIn(directory, {}, undefined, "init", "--quiet", "-b", "main", seed);
  await writeFile(join(seed, "README.md"), "base\n");
  await writeFile(join(seed, "script.sh"), "#!/bin/sh\nprintf old\n", {
    mode: 0o755,
  });
  git("add", ".");
  git(...identity, "commit", "--quiet", "-m", "Base");
  const baseSha = git("rev-parse", "HEAD");
  const remote = pathToFileURL(seed).href;

  return {
    baseSha,
    remote,
    seed,
    run(
      work: Parameters<typeof runInGitWorkspace>[2],
      options: {
        diagnostics?: Diagnostics;
        continuity?: WorkspaceContinuity;
      } = {},
    ) {
      return runInGitWorkspace(
        {
          repository: "owner/private",
          baseSha,
          defaultBranch: "main",
          author,
        },
        AbortSignal.timeout(15_000),
        work,
        remote,
        options.diagnostics,
        options.continuity,
      );
    },
    git,
  };
}

type Repository = Awaited<ReturnType<typeof repository>>;

/** Runs a Turn that carries work over, and returns what it saved. */
async function turn(
  repo: Repository,
  restore: WorkspaceContinuity["restore"],
  work: Parameters<typeof runInGitWorkspace>[2],
  workDir?: string,
) {
  let saved: Parameters<WorkspaceContinuity["saved"]>[0] | undefined;
  const result = await repo
    .run(work, {
      continuity: {
        ...(restore && { restore }),
        ...(workDir && { workDir }),
        saved: (result) => {
          saved = result;
        },
      },
    })
    .catch((error: unknown) => error);
  return { result, saved };
}

function archiveOf(
  saved: Parameters<WorkspaceContinuity["saved"]>[0] | undefined,
) {
  if (!saved || !("archive" in saved)) throw new Error("not saved");
  return saved.archive;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const result = { reply: "Done" };

test("records checkout and cleanup in diagnostics", async (t) => {
  const repo = await repository(t);
  const packets: string[] = [];
  const diagnostics = new RunnerDiagnostics(
    {
      version: 1,
      engine: "fake",
      runId: crypto.randomUUID(),
      prompt: "test",
      deadlineAt: Date.now() + 60_000,
      diagnostics: {
        traceId: "run/test",
        parentSpanId: "run/test",
        producerId: crypto.randomUUID(),
        url: "https://diag.example/diagnostics",
        bearer: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
      },
    },
    async (_url, init) => {
      packets.push(String(init?.body));
      return new Response(null, { status: 204 });
    },
  );
  await expect(repo.run(async () => result, { diagnostics })).resolves.toEqual(
    result,
  );
  await diagnostics.finish();
  const finishes = packets
    .map((packet) => parseDiagnosticBatch(JSON.parse(packet)))
    .flatMap((batch) => batch.records)
    .filter((record) => record.name === "span.finished");
  expect(
    finishes.map((record) => [
      record.attributes.operation,
      record.attributes.outcome,
    ]),
  ).toEqual([
    ["checkout", "succeeded"],
    ["cleanup", "succeeded"],
    ["cleanup", "succeeded"],
  ]);
});

test("starts like a shallow clone that the Agent commits and pushes in as the App's bot", async (t) => {
  const repo = await repository(t);
  let workspace: Workspace | undefined;
  await expect(
    repo.run(async (current) => {
      workspace = current;
      const { cwd, gitDir } = current;
      expect(await readFile(join(cwd, ".git"), "utf8")).toBe(
        `gitdir: ${gitDir}\n`,
      );
      const config = await readFile(join(gitDir, "config"), "utf8");
      // No credentials: GitHub requests get the token outside the container.
      expect(config).not.toMatch(/extraheader|Authorization|token/i);
      expect(agentGit(cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
      expect(agentGit(cwd, "rev-parse", "HEAD", "origin/main")).toBe(
        `${repo.baseSha}\n${repo.baseSha}`,
      );
      expect(agentGit(cwd, "remote", "get-url", "origin")).toBe(repo.remote);
      expect(
        agentGit(cwd, "rev-parse", "--abbrev-ref", "main@{upstream}"),
      ).toBe("origin/main");
      // The Agent owns the repository: branches, commits and pushes.
      agentGit(cwd, "switch", "--quiet", "-c", "feature");
      await writeFile(join(cwd, "README.md"), "feature\n");
      agentGit(cwd, "commit", "--quiet", "-am", "docs: change the readme");
      agentGit(cwd, "push", "--quiet", "-u", "origin", "feature");
      return result;
    }),
  ).resolves.toEqual(result);
  const pushed = repo.git("rev-parse", "refs/heads/feature");
  expect(repo.git("log", "-1", "--format=%an <%ae>|%cn <%ce>", pushed)).toBe(
    `${author.name} <${author.email}>|${author.name} <${author.email}>`,
  );
  expect(repo.git("rev-parse", `${pushed}^`)).toBe(repo.baseSha);
  // The work tree and its git directory are gone without continuity.
  expect(await exists(workspace!.cwd)).toBe(false);
  expect(await exists(workspace!.gitDir)).toBe(false);
});

test("carries branches, HEAD, the work tree, the git settings and the conversation over to the next Turn", async (t) => {
  const repo = await repository(t);
  const rollout = {
    threadId: "thread-1",
    path: "sessions/2026/11/24/rollout-2026-11-24T00-00-00-thread-1.jsonl",
    content: Buffer.from('{"type":"session_meta"}\n'),
  };
  let feature = "";
  let other = "";
  const first = await turn(repo, undefined, async ({ cwd }, conversation) => {
    expect(conversation?.resume).toBeUndefined();
    expect(conversation?.lost).toBeUndefined();
    agentGit(cwd, "switch", "--quiet", "-c", "other");
    await writeFile(join(cwd, "other.txt"), "other\n");
    agentGit(cwd, "add", "other.txt");
    agentGit(cwd, "commit", "--quiet", "-m", "feat: other");
    other = agentGit(cwd, "rev-parse", "HEAD");
    agentGit(cwd, "switch", "--quiet", "-c", "feature", "main");
    await writeFile(join(cwd, "README.md"), "committed\n");
    agentGit(cwd, "commit", "--quiet", "-am", "docs: commit");
    feature = agentGit(cwd, "rev-parse", "HEAD");
    agentGit(cwd, "push", "--quiet", "-u", "origin", "feature");
    agentGit(cwd, "config", "user.name", "Someone");
    // Uncommitted, deleted and untracked files go along too.
    await writeFile(join(cwd, "README.md"), "uncommitted\n");
    await rm(join(cwd, "script.sh"));
    await writeFile(join(cwd, "notes.txt"), "untracked\n");
    conversation?.save(rollout);
    return { reply: "first" };
  });
  expect(first.result).toMatchObject({ reply: "first" });
  const saved = await decodeSavedWork(archiveOf(first.saved));
  expect(saved).toMatchObject({
    baseSha: repo.baseSha,
    head: feature,
    branch: "refs/heads/feature",
    refs: [
      { name: "refs/heads/feature", sha: feature },
      { name: "refs/heads/main", sha: repo.baseSha },
      { name: "refs/heads/other", sha: other },
      // The remote's branches as last seen, without their history.
      { name: "refs/remotes/origin/feature", sha: feature },
      { name: "refs/remotes/origin/main", sha: repo.baseSha },
    ],
    conversation: rollout,
  });
  expect(saved.gitConfig?.toString()).toContain("name = Someone");

  const check = async (cwd: string) => {
    expect(agentGit(cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/feature");
    expect(agentGit(cwd, "rev-parse", "feature", "other", "main")).toBe(
      `${feature}\n${other}\n${repo.baseSha}`,
    );
    expect(agentGit(cwd, "config", "user.name")).toBe("Someone");
    expect(
      agentGit(cwd, "rev-parse", "--abbrev-ref", "feature@{upstream}"),
    ).toBe("origin/feature");
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe(
      "uncommitted\n",
    );
    expect(await exists(join(cwd, "script.sh"))).toBe(false);
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("untracked\n");
    // Changes stay unstaged, as the Agent left them.
    expect(agentGit(cwd, "diff", "--cached", "--name-only")).toBe("");
  };

  // A failed Turn still keeps its work for the next one.
  const second = await turn(
    repo,
    archiveOf(first.saved),
    async ({ cwd }, conversation) => {
      expect(conversation?.resume).toStrictEqual(rollout);
      expect(conversation?.lost).toBeUndefined();
      await check(cwd);
      throw new Error("Agent failed");
    },
  );
  expect(second.result).toBeInstanceOf(Error);

  const third = await turn(
    repo,
    archiveOf(second.saved),
    async ({ cwd }, conversation) => {
      // Without a newer conversation, the earlier one still continues.
      expect(conversation?.resume).toStrictEqual(rollout);
      await check(cwd);
      return { reply: "third" };
    },
  );
  expect(third.result).toMatchObject({ reply: "third" });
});

test("carries a detached HEAD and branches from a shallow fetch over", async (t) => {
  const repo = await repository(t);
  // A branch whose history does not include the base.
  repo.git("switch", "--quiet", "--orphan", "unrelated");
  await writeFile(join(repo.seed, "unrelated.txt"), "one\n");
  repo.git("add", "unrelated.txt");
  repo.git(...identity, "commit", "--quiet", "-m", "One");
  await writeFile(join(repo.seed, "unrelated.txt"), "two\n");
  repo.git(...identity, "commit", "--quiet", "-am", "Two");
  repo.git("switch", "--quiet", "main");

  let mine = "";
  const first = await turn(repo, undefined, async ({ cwd }) => {
    agentGit(cwd, "fetch", "--quiet", "--depth", "1", "origin", "unrelated");
    agentGit(cwd, "switch", "--quiet", "-c", "mine", "FETCH_HEAD");
    await writeFile(join(cwd, "unrelated.txt"), "three\n");
    agentGit(cwd, "commit", "--quiet", "-am", "feat: three");
    mine = agentGit(cwd, "rev-parse", "HEAD");
    agentGit(cwd, "switch", "--quiet", "--detach", "main");
    return result;
  });
  const saved = await decodeSavedWork(archiveOf(first.saved));
  expect(saved.branch).toBeUndefined();
  // The shallow boundary comes from the repository again.
  expect(bundlePrerequisites(saved.bundle).sort()).toEqual(
    [repo.baseSha, repo.git("rev-parse", "unrelated")].sort(),
  );

  const second = await turn(repo, archiveOf(first.saved), async ({ cwd }) => {
    expect(() => agentGit(cwd, "symbolic-ref", "--quiet", "HEAD")).toThrow();
    expect(agentGit(cwd, "rev-parse", "HEAD", "mine")).toBe(
      `${repo.baseSha}\n${mine}`,
    );
    expect(agentGit(cwd, "show", "mine:unrelated.txt")).toBe("three");
    return result;
  });
  expect(second.result).toEqual(result);
});

test("keeps the files of a branch without commits yet", async (t) => {
  const repo = await repository(t);
  const first = await turn(repo, undefined, async ({ cwd }) => {
    agentGit(cwd, "switch", "--quiet", "--orphan", "docs");
    await writeFile(join(cwd, "guide.md"), "guide\n");
    return result;
  });
  const saved = await decodeSavedWork(archiveOf(first.saved));
  expect(saved).toMatchObject({ head: repo.baseSha });
  expect(saved.branch).toBeUndefined();
  const second = await turn(repo, archiveOf(first.saved), async ({ cwd }) => {
    expect(await readFile(join(cwd, "guide.md"), "utf8")).toBe("guide\n");
    return result;
  });
  expect(second.result).toEqual(result);
});

test.for([
  ["lost", "lost"],
  ["unreadable", Buffer.from("not saved work")],
] as const)(
  "starts over from the base and tells the Agent when the previous work is %s",
  async ([, restore], t) => {
    const repo = await repository(t);
    const { result, saved } = await turn(
      repo,
      restore,
      async ({ cwd }, conversation) => {
        expect(conversation?.lost).toBe(true);
        expect(conversation?.resume).toBeUndefined();
        expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("base\n");
        expect(agentGit(cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
        return { reply: "fresh" };
      },
    );
    expect(result).toMatchObject({ reply: "fresh" });
    expect(saved && "archive" in saved).toBe(true);
  },
);

test("keeps the previous work when the Turn never reached it", async (t) => {
  const repo = await repository(t);
  let saved: unknown;
  await runInGitWorkspace(
    {
      repository: "owner/private",
      baseSha: "f".repeat(40),
      defaultBranch: "main",
      author,
    },
    AbortSignal.timeout(15_000),
    async () => ({ reply: "never" }),
    "file:///nonexistent",
    undefined,
    { restore: "lost", saved: (result) => (saved = result) },
  ).catch(() => {});
  expect(saved).toStrictEqual({ skipped: true });
  expect(repo.baseSha).toMatch(/^[a-f0-9]{40}$/);
});

test("uses the work left in place when it is exactly the saved work", async (t) => {
  const repo = await repository(t);
  const kept = await mkdtemp(join(tmpdir(), "tailos-work-"));
  t.onTestFinished(() => rm(kept, { recursive: true, force: true }));
  const first = await turn(
    repo,
    undefined,
    async ({ cwd }) => {
      await writeFile(join(cwd, ".gitignore"), "deps/\n");
      await mkdir(join(cwd, "deps"));
      // Ignored files are not saved, but survive in a kept container.
      await writeFile(join(cwd, "deps", "installed"), "yes\n");
      agentGit(cwd, "switch", "--quiet", "-c", "feature");
      agentGit(cwd, "config", "user.name", "Someone");
      return { reply: "first" };
    },
    kept,
  );
  const archive = archiveOf(first.saved);

  const seen = async (workDir: string) => {
    let installed = false;
    await turn(
      repo,
      archive,
      async ({ cwd }) => {
        expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe("deps/\n");
        expect(agentGit(cwd, "symbolic-ref", "HEAD")).toBe(
          "refs/heads/feature",
        );
        expect(agentGit(cwd, "config", "user.name")).toBe("Someone");
        installed = await exists(join(cwd, "deps", "installed"));
        return { reply: "next" };
      },
      workDir,
    );
    return installed;
  };
  expect(await seen(kept)).toBe(true);

  // A new container has nothing in place and restores the saved work.
  const fresh = await mkdtemp(join(tmpdir(), "tailos-work-"));
  t.onTestFinished(() => rm(fresh, { recursive: true, force: true }));
  expect(await seen(fresh)).toBe(false);

  // Work in place is not used once it differs from the saved work.
  agentGit(join(kept, "repo"), "branch", "extra");
  expect(await seen(kept)).toBe(false);
});

test("the Runner's own git commands never read the Agent's git settings", async (t) => {
  const repo = await repository(t);
  const marker = join(await mkdtemp(join(tmpdir(), "tailos-marker-")), "ran");
  t.onTestFinished(() => rm(marker, { recursive: true, force: true }));
  const { result, saved } = await turn(repo, undefined, async ({ cwd }) => {
    // Saving runs `git add`: a clean filter would run here if it were read.
    await writeFile(join(cwd, ".gitattributes"), "* filter=evil\n");
    agentGit(cwd, "config", "filter.evil.clean", `touch ${marker}; cat`);
    agentGit(cwd, "config", "core.pager", `touch ${marker}`);
    return { reply: "first" };
  });
  expect(result).toMatchObject({ reply: "first" });
  expect(await exists(marker)).toBe(false);
  const work = await decodeSavedWork(archiveOf(saved));
  // The Agent's settings are kept as data for the next Turn.
  expect(work.gitConfig?.toString()).toContain('[filter "evil"]');

  await turn(repo, archiveOf(saved), async ({ cwd }) => {
    expect(agentGit(cwd, "config", "filter.evil.clean")).toContain("touch");
    return { reply: "second" };
  });
  expect(await exists(marker)).toBe(false);
});

test("never writes the git settings through a link the Agent left", async (t) => {
  const repo = await repository(t);
  const outside = await mkdtemp(join(tmpdir(), "tailos-outside-"));
  t.onTestFinished(() => rm(outside, { recursive: true, force: true }));
  const target = join(outside, "runner.cjs");
  await writeFile(target, "the Runner's own file\n");
  const { result, saved } = await turn(repo, undefined, async ({ gitDir }) => {
    await rm(join(gitDir, "config"));
    await symlink(target, join(gitDir, "config"));
    return { reply: "linked" };
  });
  expect(result).toMatchObject({ reply: "linked" });
  expect(await readFile(target, "utf8")).toBe("the Runner's own file\n");
  // A link is not the Agent's settings: the next Turn gets the Runner's.
  expect((await decodeSavedWork(archiveOf(saved))).gitConfig).toBeUndefined();
});

test("writes nothing through links the Agent left in the git directory", async (t) => {
  const repo = await repository(t);
  const kept = await mkdtemp(join(tmpdir(), "tailos-work-"));
  t.onTestFinished(() => rm(kept, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), "tailos-outside-"));
  t.onTestFinished(() => rm(outside, { recursive: true, force: true }));
  const plant = async (gitDir: string) => {
    // Where the Runner would write a reference or a loose object.
    await rm(join(gitDir, "refs", "tailos"), { recursive: true, force: true });
    await symlink(outside, join(gitDir, "refs", "tailos"));
    for (let i = 0; i < 256; i++) {
      const fanout = join(gitDir, "objects", i.toString(16).padStart(2, "0"));
      if (!(await exists(fanout))) await symlink(outside, fanout);
    }
  };
  const first = await turn(
    repo,
    undefined,
    async ({ cwd, gitDir }) => {
      await writeFile(join(cwd, "notes.txt"), "untracked\n");
      await plant(gitDir);
      return result;
    },
    kept,
  );
  const archive = archiveOf(first.saved);
  // Looking at the work left in place writes nothing through them either.
  const second = await turn(
    repo,
    archive,
    async ({ cwd }) => {
      expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe(
        "untracked\n",
      );
      return result;
    },
    kept,
  );
  expect(second.result).toEqual(result);
  expect(await readdir(outside)).toEqual([]);
});

test("does not save a git directory that refers to another one", async (t) => {
  const repo = await repository(t);
  const { saved } = await turn(repo, undefined, async ({ gitDir }) => {
    await writeFile(join(gitDir, "commondir"), "/tmp/elsewhere\n");
    return result;
  });
  expect(saved).toStrictEqual({ failed: "error" });
});

test("restores work saved before Sessions kept branches", async (t) => {
  const repo = await repository(t);
  // What a Turn saved then: a work commit on HEAD, and work kept aside after
  // a merge, in a bundle from the base.
  const tree = (contents: string) => {
    const blob = gitIn(
      repo.seed,
      {},
      Buffer.from(contents),
      "hash-object",
      "-w",
      "--stdin",
    );
    return gitIn(
      repo.seed,
      {},
      Buffer.from(`100644 blob ${blob}\tREADME.md\n`),
      "mktree",
    );
  };
  const commit = (contents: string, message: string) =>
    repo.git(
      ...identity,
      "commit-tree",
      tree(contents),
      "-p",
      repo.baseSha,
      "-m",
      message,
    );
  const work = commit("saved\n", "Tailos saved work");
  const kept = commit("kept\n", "Tailos unpublished work");
  repo.git("update-ref", "refs/tailos/continuity", work);
  repo.git("update-ref", "refs/tailos/unpublished", kept);
  const bundle = join(repo.seed, "..", "old.bundle");
  repo.git(
    "bundle",
    "create",
    bundle,
    "refs/tailos/continuity",
    "refs/tailos/unpublished",
    `^${repo.baseSha}`,
  );
  const data = await readFile(bundle);
  const archive = await promisify(gzip)(
    Buffer.concat([
      Buffer.from(
        JSON.stringify({
          version: 1,
          baseSha: repo.baseSha,
          head: repo.baseSha,
          work,
          bundle: data.length,
          kept,
        }) + "\n",
      ),
      data,
    ]),
  );

  const { result: restored, saved } = await turn(
    repo,
    archive,
    async ({ cwd }, conversation) => {
      expect(conversation?.lost).toBeUndefined();
      expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("saved\n");
      expect(
        agentGit(cwd, "rev-parse", "HEAD", "refs/tailos/unpublished"),
      ).toBe(`${repo.baseSha}\n${kept}`);
      // It starts like a clone, as a new Session does.
      expect(agentGit(cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
      expect(agentGit(cwd, "rev-parse", "origin/main")).toBe(repo.baseSha);
      // The Runner's settings, with the App's bot as the author.
      expect(agentGit(cwd, "config", "user.name")).toBe(author.name);
      return result;
    },
  );
  expect(restored).toEqual(result);
  // Kept work still goes along, until the Agent deletes it.
  expect((await decodeSavedWork(archiveOf(saved))).refs).toEqual([
    { name: "refs/heads/main", sha: repo.baseSha },
    { name: "refs/remotes/origin/main", sha: repo.baseSha },
    { name: "refs/tailos/unpublished", sha: kept },
  ]);
});

test("reads the commits a bundle needs from its header", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  expect(
    bundlePrerequisites(
      Buffer.from(
        `# v2 git bundle\n-${a} Base\n-${b}\n${"c".repeat(40)} refs/heads/x\n\nPACK`,
      ),
    ),
  ).toEqual([a, b]);
  expect(() => bundlePrerequisites(Buffer.from("not a bundle\n\n"))).toThrow();
});

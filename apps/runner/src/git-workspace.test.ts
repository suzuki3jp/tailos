import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi, type TestContext } from "vitest";
import {
  runInGitWorkspace,
  type WorkspaceContinuity,
} from "@/git-workspace.ts";
import { decodeSavedWork } from "@/continuity.ts";
import { access } from "node:fs/promises";
import {
  parseDiagnosticBatch,
  type Diagnostics,
} from "@tailos/core/diagnostics";
import { RunnerDiagnostics } from "@/diagnostics.ts";

async function repository(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "tailos-git-test-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const seed = join(directory, "seed");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      encoding: "utf8",
    }).trim();

  git(directory, "init", "--quiet", "-b", "main", seed);
  await writeFile(join(seed, "README.md"), "base\n");
  await writeFile(join(seed, "script.sh"), "#!/bin/sh\nprintf old\n", {
    mode: 0o755,
  });
  git(seed, "add", ".");
  git(
    seed,
    "-c",
    "user.name=Seed",
    "-c",
    "user.email=seed@example.test",
    "commit",
    "--quiet",
    "-m",
    "Base",
  );
  const baseSha = git(seed, "rev-parse", "HEAD");
  const branch = "tailos/issue-8/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  return {
    baseSha,
    branch,
    run(
      work: Parameters<typeof runInGitWorkspace>[2],
      stage: Parameters<typeof runInGitWorkspace>[3],
      mode?: "plan",
      diagnostics?: Diagnostics,
      continuity?: WorkspaceContinuity,
    ) {
      return runInGitWorkspace(
        {
          repository: "owner/private",
          baseSha,
          branch,
        },
        AbortSignal.timeout(15_000),
        work,
        stage,
        pathToFileURL(seed).href,
        diagnostics,
        mode,
        continuity,
      );
    },
    refs: () => git(seed, "for-each-ref", "--format=%(refname)"),
  };
}

const result = { reply: "Renamed README", headline: "docs: rename readme" };

test("records the failing publication stage and completes workspace cleanup", async (t) => {
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
  const failure = new Error("Publication checkpoint unavailable");
  await expect(
    repo.run(
      async (cwd) => {
        await writeFile(join(cwd, "README.md"), "updated\n");
        return result;
      },
      async () => {
        throw failure;
      },
      undefined,
      diagnostics,
    ),
  ).rejects.toBe(failure);
  await diagnostics.finish();
  const batches = packets.map((packet) =>
    parseDiagnosticBatch(JSON.parse(packet)),
  );
  const finishes = batches
    .flatMap((batch) => batch.records)
    .filter((record) => record.name === "span.finished");
  expect(
    finishes.map((record) => [
      record.attributes.operation,
      record.attributes.outcome,
    ]),
  ).toEqual([
    ["checkout", "succeeded"],
    ["workspace", "succeeded"],
    ["publication", "failed"],
    ["cleanup", "succeeded"],
    ["cleanup", "succeeded"],
  ]);
  expect(JSON.parse(finishes[2]!.body!).errors[0].message).toBe(
    failure.message,
  );
  expect(batches.at(-1)?.completed?.dropped).toBe(0);
});

test("stages changes without a package manifest, pushing, or storing credentials", async (t) => {
  const repo = await repository(t);
  const stage = vi.fn();
  await expect(
    repo.run(async (cwd) => {
      const pointer = await readFile(join(cwd, ".git"), "utf8");
      const metadata = pointer.slice("gitdir: ".length).trim();
      expect(await readFile(join(metadata, "config"), "utf8")).not.toMatch(
        /extraheader|Authorization/i,
      );
      await rm(join(cwd, ".git"));
      await rename(join(cwd, "README.md"), join(cwd, "Guide.md"));
      return { ...result, sessionTitle: "Documentation update" };
    }, stage),
  ).resolves.toEqual({
    reply: result.reply,
    sessionTitle: "Documentation update",
    publication: { kind: "checked" },
  });
  expect(stage).toHaveBeenCalledExactlyOnceWith({
    ...result,
    sessionTitle: "Documentation update",
    baseSha: repo.baseSha,
    branch: repo.branch,
    tree: expect.stringMatching(/^[a-f0-9]{40}$/),
    changes: {
      additions: [
        {
          path: "Guide.md",
          contents: Buffer.from("base\n").toString("base64"),
        },
      ],
      deletions: [{ path: "README.md" }],
    },
  });
  expect(repo.refs()).toBe("refs/heads/main");
});

test("stages an existing executable with a content-only edit", async (t) => {
  const repo = await repository(t);
  const contents = "#!/bin/sh\nprintf new\n";
  const stage = vi.fn();

  await expect(
    repo.run(async (cwd) => {
      await writeFile(join(cwd, "script.sh"), contents);
      return {
        reply: "Updated script",
        headline: "fix: update script output",
      };
    }, stage),
  ).resolves.toMatchObject({ publication: { kind: "checked" } });
  expect(stage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      changes: {
        additions: [
          {
            path: "script.sh",
            contents: Buffer.from(contents).toString("base64"),
          },
        ],
        deletions: [],
      },
    }),
  );
});

test("rejects changes to executable mode and new executable files", async (t) => {
  const repo = await repository(t);
  const stage = vi.fn();
  await expect(
    repo.run(async (cwd) => {
      await chmod(join(cwd, "README.md"), 0o755);
      return result;
    }, stage),
  ).rejects.toMatchObject({ code: "unsupported_changes" });
  await expect(
    repo.run(async (cwd) => {
      await writeFile(join(cwd, "new-script.sh"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      return result;
    }, stage),
  ).rejects.toMatchObject({ code: "unsupported_changes" });
  expect(stage).not.toHaveBeenCalled();
});

test("returns no changes without staging", async (t) => {
  const repo = await repository(t);
  const stage = vi.fn();
  await expect(
    repo.run(async () => ({ reply: "No work" }), stage),
  ).resolves.toEqual({ reply: "No work", publication: { kind: "no_changes" } });
  expect(stage).not.toHaveBeenCalled();
});

test("rejects an invalid headline and changes to trusted Git config before publication", async (t) => {
  const repo = await repository(t);
  const stage = vi.fn();
  await expect(
    repo.run(async (cwd) => {
      await writeFile(join(cwd, "README.md"), "changed\n");
      return { ...result, headline: "Implement GitHub issue\nextra line" };
    }, stage),
  ).rejects.toMatchObject({ code: "invalid_change_headline" });
  await expect(
    repo.run(async (cwd) => {
      const pointer = await readFile(join(cwd, ".git"), "utf8");
      await writeFile(
        join(pointer.slice("gitdir: ".length).trim(), "config"),
        "[core]\nfsmonitor = /bin/false\n",
      );
      return result;
    }, stage),
  ).rejects.toThrow("Git metadata configuration changed");
  expect(stage).not.toHaveBeenCalled();
});

test("planning reads the base and skips staging, even if an adapter returns changes", async (t) => {
  const repo = await repository(t);
  const stage = vi.fn();
  const plan = { planPresented: false, needsAnswer: true };
  let workspace = "";
  await expect(
    repo.run(
      async (cwd) => {
        workspace = cwd;
        expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("base\n");
        await writeFile(join(cwd, "README.md"), "untrusted adapter");
        return { reply: "Which behavior is desired?", plan };
      },
      stage,
      "plan",
    ),
  ).resolves.toEqual({ reply: "Which behavior is desired?", plan });
  expect(stage).not.toHaveBeenCalled();
  await expect(readFile(join(workspace, "README.md"))).rejects.toThrow();
});

/** Runs a Turn that carries work over, and returns what it saved. */
async function turn(
  repo: Awaited<ReturnType<typeof repository>>,
  restore: WorkspaceContinuity["restore"],
  work: Parameters<typeof runInGitWorkspace>[2],
  workDir?: string,
) {
  let saved: Parameters<WorkspaceContinuity["saved"]>[0] | undefined;
  const result = await repo
    .run(work, async () => {}, undefined, undefined, {
      ...(restore && { restore }),
      ...(workDir && { workDir }),
      saved: (result) => {
        saved = result;
      },
    })
    .catch((error: unknown) => error);
  return { result, saved };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

test("carries the work tree and conversation over to the next Turn", async (t) => {
  const repo = await repository(t);
  const rollout = {
    threadId: "thread-1",
    path: "sessions/2026/11/24/rollout-2026-11-24T00-00-00-thread-1.jsonl",
    content: Buffer.from('{"type":"session_meta"}\n'),
  };
  const first = await turn(repo, undefined, async (cwd, conversation) => {
    expect(conversation?.resume).toBeUndefined();
    expect(conversation?.lost).toBeUndefined();
    await writeFile(join(cwd, "README.md"), "changed\n");
    await rm(join(cwd, "script.sh"));
    await writeFile(join(cwd, "notes.txt"), "untracked\n");
    conversation?.save(rollout);
    return { reply: "first", headline: "docs: change the readme" };
  });
  expect(first.result).toMatchObject({ reply: "first" });
  if (!first.saved || !("archive" in first.saved)) throw new Error("not saved");
  const saved = await decodeSavedWork(first.saved.archive);
  expect(saved.baseSha).toBe(repo.baseSha);
  expect(saved.head).toBe(repo.baseSha);
  expect(saved.conversation).toStrictEqual(rollout);

  // A failed Turn still keeps its work for the next one.
  const second = await turn(
    repo,
    first.saved.archive,
    async (cwd, conversation) => {
      expect(conversation?.resume).toStrictEqual(rollout);
      expect(conversation?.lost).toBeUndefined();
      expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("changed\n");
      expect(await exists(join(cwd, "script.sh"))).toBe(false);
      expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe(
        "untracked\n",
      );
      await writeFile(join(cwd, "more.txt"), "more\n");
      throw new Error("Agent failed");
    },
  );
  expect(second.result).toBeInstanceOf(Error);
  if (!second.saved || !("archive" in second.saved))
    throw new Error("not saved");

  const third = await turn(
    repo,
    second.saved.archive,
    async (cwd, conversation) => {
      // Without a newer conversation, the earlier one still continues.
      expect(conversation?.resume).toStrictEqual(rollout);
      expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("changed\n");
      expect(await readFile(join(cwd, "more.txt"), "utf8")).toBe("more\n");
      return { reply: "third", headline: "docs: add more" };
    },
  );
  // The publication covers everything since the base, including earlier Turns.
  expect(third.result).toMatchObject({ publication: { kind: "checked" } });
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
      async (cwd, conversation) => {
        expect(conversation?.lost).toBe(true);
        expect(conversation?.resume).toBeUndefined();
        expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("base\n");
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
      branch: repo.branch,
    },
    AbortSignal.timeout(15_000),
    async () => ({ reply: "never" }),
    async () => {},
    "file:///nonexistent",
    undefined,
    undefined,
    { restore: "lost", saved: (result) => (saved = result) },
  ).catch(() => {});
  expect(saved).toStrictEqual({ skipped: true });
});

test("uses the work left in place when it is exactly the saved work", async (t) => {
  const repo = await repository(t);
  const kept = await mkdtemp(join(tmpdir(), "tailos-work-"));
  t.onTestFinished(() => rm(kept, { recursive: true, force: true }));
  const first = await turn(
    repo,
    undefined,
    async (cwd) => {
      await writeFile(join(cwd, ".gitignore"), "deps/\n");
      await mkdir(join(cwd, "deps"));
      // Ignored files are not saved, but survive in a kept container.
      await writeFile(join(cwd, "deps", "installed"), "yes\n");
      return { reply: "first" };
    },
    kept,
  );
  if (!first.saved || !("archive" in first.saved)) throw new Error("not saved");
  const archive = first.saved.archive;

  const seen = async (workDir: string) => {
    let installed = false;
    await turn(
      repo,
      archive,
      async (cwd) => {
        expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe("deps/\n");
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

  // Work in place is not trusted once its git configuration changed.
  await writeFile(
    join(kept, "git", "config"),
    (await readFile(join(kept, "git", "config"), "utf8")) +
      "[core]\n\tpager = sh\n",
  );
  expect(await seen(kept)).toBe(false);
});

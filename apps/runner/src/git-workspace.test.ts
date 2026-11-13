import { execFileSync } from "node:child_process";
import {
  chmod,
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
import { runInGitWorkspace } from "@/git-workspace.ts";

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
    ) {
      return runInGitWorkspace(
        {
          repository: "owner/private",
          baseSha,
          branch,
          token: "secret-repo-token",
        },
        AbortSignal.timeout(15_000),
        work,
        stage,
        pathToFileURL(seed).href,
        undefined,
        mode,
      );
    },
    refs: () => git(seed, "for-each-ref", "--format=%(refname)"),
  };
}

const result = { reply: "Renamed README", headline: "docs: rename readme" };

test("stages changes without a package manifest, pushing, or storing credentials", async (t) => {
  const repo = await repository(t);
  const stage = vi.fn();
  await expect(
    repo.run(async (cwd) => {
      const pointer = await readFile(join(cwd, ".git"), "utf8");
      const metadata = pointer.slice("gitdir: ".length).trim();
      expect(await readFile(join(metadata, "config"), "utf8")).not.toContain(
        "secret-repo-token",
      );
      await rm(join(cwd, ".git"));
      await rename(join(cwd, "README.md"), join(cwd, "Guide.md"));
      return result;
    }, stage),
  ).resolves.toEqual({ reply: result.reply, publication: { kind: "checked" } });
  expect(stage).toHaveBeenCalledExactlyOnceWith({
    ...result,
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

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, expect, test } from "vitest";
import { pathToFileURL } from "node:url";
import { runInGitWorkspace } from "./git-workspace.ts";

test("pushes changes to the assigned branch without changing the base ref or storing credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meguri-git-test-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "remote.git");
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

  git(directory, "init", "--quiet", "--bare", repository);
  git(directory, "init", "--quiet", "-b", "main", seed);
  await writeFile(join(seed, "README.md"), "base\n");
  git(seed, "add", "README.md");
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
  git(seed, "push", "--quiet", repository, "main");
  const baseSha = git(seed, "rev-parse", "HEAD");
  const branch = "meguri/issue-8/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const checkout = {
    repository: "owner/private",
    baseSha,
    branch,
    token: "secret-repo-token",
  };
  const remote = pathToFileURL(repository).href;
  const signal = AbortSignal.timeout(15_000);

  let stagedSha: string | undefined;
  const result = await runInGitWorkspace(
    checkout,
    signal,
    async (cwd) => {
      expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("base\n");
      const pointer = await readFile(join(cwd, ".git"), "utf8");
      expect(pointer).toMatch(/^gitdir: /);
      const metadata = pointer.slice("gitdir: ".length).trim();
      expect(await readFile(join(metadata, "config"), "utf8")).not.toMatch(
        /secret-repo-token/,
      );
      await rm(join(cwd, ".git"));
      await mkdir(join(cwd, ".git"));
      await writeFile(
        join(cwd, ".git", "config"),
        "[core]\nfsmonitor = /bin/false\n[http]\nproxy = http://127.0.0.1:9\n",
      );
      await writeFile(join(cwd, "README.md"), "changed\n");
      return "Edited README";
    },
    remote,
    async ({ branch: stagedBranch, sha, reply }) => {
      expect(stagedBranch).toBe(branch);
      stagedSha = sha;
      expect(reply).toBe("Edited README");
      expect(() =>
        git(repository, "show-ref", "--verify", `refs/heads/${branch}`),
      ).toThrow();
    },
  );
  expect(result.reply).toBe("Edited README");
  assert(result.publication.kind === "pushed");
  expect(stagedSha).toBe(result.publication.sha);
  expect(git(repository, "rev-parse", "refs/heads/main")).toBe(baseSha);
  expect(git(repository, "rev-parse", `refs/heads/${branch}`)).toBe(
    result.publication.sha,
  );
  expect(git(repository, "show", `${branch}:README.md`)).toBe("changed");
  await expect(
    runInGitWorkspace(
      checkout,
      signal,
      async (cwd) => {
        const pointer = await readFile(join(cwd, ".git"), "utf8");
        const metadata = pointer.slice("gitdir: ".length).trim();
        await writeFile(
          join(metadata, "config"),
          "[core]\nfsmonitor = /bin/false\n",
        );
        return "tampered";
      },
      remote,
    ),
  ).rejects.toThrow(/Git metadata configuration changed/);
  expect(
    (await runInGitWorkspace(checkout, signal, async () => "No work", remote))
      .publication,
  ).toStrictEqual({ kind: "no_changes" });
});

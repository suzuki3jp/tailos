import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi, type TestContext } from "vitest";
import { PublicationFailed } from "./agent.ts";
import { runInGitWorkspace } from "./git-workspace.ts";

async function repository(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "meguri-git-test-"));
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
  await writeFile(
    join(seed, "package.json"),
    JSON.stringify({
      scripts: { "format:check": "oxfmt --check .", lint: "oxlint ." },
    }),
  );
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
  const branch = "meguri/issue-8/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  return {
    baseSha,
    branch,
    run(
      work: Parameters<typeof runInGitWorkspace>[2],
      check: Parameters<typeof runInGitWorkspace>[3],
      stage: Parameters<typeof runInGitWorkspace>[4],
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
        check,
        stage,
        pathToFileURL(seed).href,
      );
    },
    refs: () => git(seed, "for-each-ref", "--format=%(refname)"),
  };
}

const result = { reply: "Renamed README", headline: "docs: rename readme" };

test("checks and stages the same tree, without pushing or storing credentials", async (t) => {
  const repo = await repository(t);
  const check = vi.fn(async (cwd: string) => {
    expect(await readFile(join(cwd, "Guide.md"), "utf8")).toBe("base\n");
    await expect(readFile(join(cwd, "README.md"))).rejects.toThrow();
  });
  const stage = vi.fn(async () => {
    expect(check).toHaveBeenCalledTimes(1);
  });
  await expect(
    repo.run(
      async (cwd) => {
        const pointer = await readFile(join(cwd, ".git"), "utf8");
        const metadata = pointer.slice("gitdir: ".length).trim();
        expect(await readFile(join(metadata, "config"), "utf8")).not.toContain(
          "secret-repo-token",
        );
        await rm(join(cwd, ".git"));
        await rename(join(cwd, "README.md"), join(cwd, "Guide.md"));
        return result;
      },
      check,
      stage,
    ),
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

test("checks and stages an existing executable with a content-only edit", async (t) => {
  const repo = await repository(t);
  const contents = "#!/bin/sh\nprintf new\n";
  const check = vi.fn(async (cwd: string) => {
    const path = join(cwd, "script.sh");
    expect(await readFile(path, "utf8")).toBe(contents);
    expect((await stat(path)).mode & 0o100).toBe(0o100);
  });
  const stage = vi.fn();

  await expect(
    repo.run(
      async (cwd) => {
        await writeFile(join(cwd, "script.sh"), contents);
        return {
          reply: "Updated script",
          headline: "fix: update script output",
        };
      },
      check,
      stage,
    ),
  ).resolves.toMatchObject({ publication: { kind: "checked" } });
  expect(check).toHaveBeenCalledTimes(1);
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

test.for(["format_check_failed", "lint_failed"] as const)(
  "leaves no publication checkpoint after %s",
  async (errorCode, t) => {
    const repo = await repository(t);
    const stage = vi.fn();
    await expect(
      repo.run(
        async (cwd) => {
          await writeFile(join(cwd, "README.md"), "changed\n");
          return result;
        },
        async () => {
          throw new PublicationFailed(errorCode);
        },
        stage,
      ),
    ).rejects.toMatchObject({ code: errorCode });
    expect(stage).not.toHaveBeenCalled();
  },
);

test("fails closed if the Agent changes the verification script or file mode", async (t) => {
  const repo = await repository(t);
  const check = vi.fn();
  const stage = vi.fn();
  await expect(
    repo.run(
      async (cwd) => {
        await writeFile(
          join(cwd, "package.json"),
          '{"scripts":{"format:check":"true","lint":"oxlint ."}}',
        );
        return result;
      },
      check,
      stage,
    ),
  ).rejects.toMatchObject({ code: "format_check_failed" });
  await expect(
    repo.run(
      async (cwd) => {
        await chmod(join(cwd, "README.md"), 0o755);
        return result;
      },
      check,
      stage,
    ),
  ).rejects.toMatchObject({ code: "unsupported_changes" });
  await expect(
    repo.run(
      async (cwd) => {
        await writeFile(join(cwd, "new-script.sh"), "#!/bin/sh\n", {
          mode: 0o755,
        });
        return result;
      },
      check,
      stage,
    ),
  ).rejects.toMatchObject({ code: "unsupported_changes" });
  expect(check).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
});

test("returns no changes without checking or staging", async (t) => {
  const repo = await repository(t);
  const check = vi.fn();
  const stage = vi.fn();
  await expect(
    repo.run(async () => ({ reply: "No work" }), check, stage),
  ).resolves.toEqual({ reply: "No work", publication: { kind: "no_changes" } });
  expect(check).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
});

test("rejects an invalid headline and changes to trusted Git config before publication", async (t) => {
  const repo = await repository(t);
  const check = vi.fn();
  const stage = vi.fn();
  await expect(
    repo.run(
      async (cwd) => {
        await writeFile(join(cwd, "README.md"), "changed\n");
        return { ...result, headline: "Implement GitHub issue\nextra line" };
      },
      check,
      stage,
    ),
  ).rejects.toMatchObject({ code: "invalid_change_headline" });
  await expect(
    repo.run(
      async (cwd) => {
        const pointer = await readFile(join(cwd, ".git"), "utf8");
        await writeFile(
          join(pointer.slice("gitdir: ".length).trim(), "config"),
          "[core]\nfsmonitor = /bin/false\n",
        );
        return result;
      },
      check,
      stage,
    ),
  ).rejects.toThrow("Git metadata configuration changed");
  expect(check).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
});

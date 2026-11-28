import { expect, test } from "vitest";
import * as v from "valibot";
import { normalizeSessionTitle, RunnerStatus } from "@tailos/core/runner";
import {
  agentPrompt,
  runAgentTurns,
  replySchema,
  type RepositoryJob,
} from "./agent-turns.ts";

const job: RepositoryJob = {
  version: 1,
  engine: "codex",
  runId: crypto.randomUUID(),
  prompt: "Work",
  deadlineAt: Date.now() + 600_000,
  access: {
    accessToken: "access",
    accountId: "account",
    connectionVersion: crypto.randomUUID(),
    accessVersion: crypto.randomUUID(),
  },
  checkout: {
    repository: "owner/repo",
    baseSha: "b".repeat(40),
    defaultBranch: "main",
    author: {
      name: "tailos-app[bot]",
      email: "1+tailos-app[bot]@users.noreply.github.com",
    },
  },
};

test("title validation accepts Unicode content while independently ignoring invalid and legacy values", () => {
  expect(normalizeSessionTitle("\u3000Title\u00a0")).toBe("Title");
  expect(normalizeSessionTitle("x".repeat(100))).toHaveLength(100);
  expect(normalizeSessionTitle("👩‍💻 の作業")).toBe("👩‍💻 の作業");
  for (const title of [
    undefined,
    null,
    1,
    {},
    [],
    "",
    "  ",
    "x".repeat(101),
    "😀".repeat(51),
    "a\nb",
    "a\tb",
    "a\u0085b",
    "a\u2028b",
    "a\u2029b",
  ]) {
    expect(normalizeSessionTitle(title)).toBeUndefined();
    const result = v.parse(RunnerStatus, {
      status: "succeeded",
      reply: "Done",
      events: [],
      ...(title !== undefined && { sessionTitle: title }),
    });
    expect(result).toMatchObject({ status: "succeeded", reply: "Done" });
  }
});

test("a repository Turn preserves its work when only the title is missing or malformed", async () => {
  for (const title of [
    undefined,
    null,
    7,
    "",
    "a\nb",
    "secret-value",
    "x".repeat(101),
    "  会話の目的  ",
  ]) {
    const answer = {
      reply: "Done",
      ...(title !== undefined && { sessionTitle: title }),
    };
    const result = await runAgentTurns({
      job,
      signal: new AbortController().signal,
      prompt: "Work",
      sensitive: ["secret-value"],
      turn: async () => JSON.stringify(answer),
    });
    expect(result).toEqual({
      reply: "Done",
      ...(title === "  会話の目的  " && { sessionTitle: "会話の目的" }),
    });
  }
  expect(replySchema(job)).toEqual({
    type: "object",
    properties: {
      reply: { type: "string" },
      sessionTitle: { type: ["string", "null"] },
    },
    required: ["reply", "sessionTitle"],
    additionalProperties: false,
  });
});

test("shortening retains the first valid title and keeps the existing validation of the main answer", async () => {
  const result = await runAgentTurns({
    job,
    signal: new AbortController().signal,
    prompt: "Work",
    sensitive: [],
    turn: async (_prompt, revision) =>
      JSON.stringify({
        reply: revision === 0 ? "x".repeat(8001) : "Shortened",
        headline: "feat: work",
        sessionTitle: revision === 0 ? "Original title" : "Changed title",
      }),
  });
  expect(result).toMatchObject({
    reply: "Shortened",
    sessionTitle: "Original title",
  });
  await expect(
    runAgentTurns({
      job,
      signal: new AbortController().signal,
      prompt: "Work",
      sensitive: [],
      turn: async () => JSON.stringify({ sessionTitle: "Valid title" }),
    }),
  ).rejects.toThrow();
});

test("a Routine's message follows its prompt", () => {
  const prompt = agentPrompt(
    { ...job, message: "@tailos plan Use option B" },
    "tailos_github_get",
  );
  expect(prompt.indexOf("Work")).toBeLessThan(
    prompt.indexOf("@tailos plan Use option B"),
  );
  expect(agentPrompt(job, "tailos_github_get")).not.toContain(
    "The message to answer",
  );
});

test("every repository Turn gets the same instructions, with no read-only mode", () => {
  const planning = agentPrompt(
    { ...job, prompt: "Plan the issue.", message: "@tailos plan" },
    "tailos_github_get",
  );
  const implementing = agentPrompt(
    { ...job, prompt: "Implement the issue.", message: "@tailos plan" },
    "tailos_github_get",
  );
  expect(planning.replace("Plan the issue.", "")).toBe(
    implementing.replace("Implement the issue.", ""),
  );
  expect(planning).not.toMatch(/read-only|planPresented|needsAnswer/);
  // Checks follow changes, so a Turn that only reads need not run them.
  expect(planning).toContain("When you change files,");
  expect(planning).toContain("git and gh are signed in");
});

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
  refresh: { url: "https://api.example/refresh", bearer: "a".repeat(64) },
  checkout: {
    repository: "owner/repo",
    baseSha: "b".repeat(40),
    branch: `tailos/issue-3/${crypto.randomUUID()}`,
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

test("both response modes preserve normal work when only the title is missing or malformed", async () => {
  for (const mode of ["plan", "implement"] as const) {
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
      const current = { ...job, mode };
      const answer = {
        reply: "Done",
        ...(mode === "plan"
          ? { planPresented: true, needsAnswer: false }
          : { headline: "feat: work" }),
        ...(title !== undefined && { sessionTitle: title }),
      };
      const result = await runAgentTurns({
        job: current,
        signal: new AbortController().signal,
        prompt: "Work",
        sensitive: ["secret-value"],
        turn: async () => JSON.stringify(answer),
      });
      expect(result.reply).toBe("Done");
      expect(result.sessionTitle).toBe(
        title === "  会話の目的  " ? "会話の目的" : undefined,
      );
      expect(replySchema(current)?.properties.sessionTitle).toEqual({
        type: ["string", "null"],
      });
    }
  }
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
      job: { ...job, mode: "plan" },
      signal: new AbortController().signal,
      prompt: "Work",
      sensitive: [],
      turn: async () =>
        JSON.stringify({
          reply: "Done",
          sessionTitle: "Valid title",
          planPresented: "wrong",
          needsAnswer: false,
        }),
    }),
  ).rejects.toThrow();
});

test("a Routine's message follows its prompt in either mode", () => {
  const message = { ...job, message: "@tailos plan Use option B" };
  for (const mode of [undefined, "plan" as const]) {
    const prompt = agentPrompt({ ...message, mode }, "tailos_github_get");
    expect(prompt.indexOf("Work")).toBeLessThan(
      prompt.indexOf("@tailos plan Use option B"),
    );
  }
  expect(agentPrompt(job, "tailos_github_get")).not.toContain(
    "The message to answer",
  );
});

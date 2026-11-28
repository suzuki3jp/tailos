import { expect, test } from "vitest";
import * as v from "valibot";
import { ExecutionContext, triggerIssue } from "@tailos/core/runner";

const repository = {
  repository: "owner/repo",
  repositoryId: 42,
  installationId: 19,
  defaultBranch: "main",
};
const base = {
  version: 1,
  engine: "codex",
  connectionId: "codex/00000000-0000-4000-8000-000000000001",
};
const hash = "a".repeat(64);

test("stored contexts from before triggers are read as the matching issue trigger", () => {
  expect(
    v.parse(ExecutionContext, {
      ...base,
      repository: {
        ...repository,
        issueNumber: 8,
        issueContentHash: hash,
        triggerLabel: "build",
      },
    }),
  ).toEqual({
    ...base,
    repository,
    trigger: {
      kind: "github.issue-label",
      issueNumber: 8,
      issueContentHash: hash,
      label: "build",
    },
  });
  expect(
    v.parse(ExecutionContext, {
      ...base,
      mode: "plan",
      repository: { ...repository, issueNumber: 8 },
    }),
  ).toEqual({
    ...base,
    repository,
    trigger: { kind: "github.issue-comment", issueNumber: 8 },
  });
});

test("stored contexts drop the removed execution mode", () => {
  const trigger = { kind: "github.issue-comment", issueNumber: 8 };
  for (const mode of ["plan", "implement"])
    expect(
      v.parse(ExecutionContext, { ...base, mode, repository, trigger }),
    ).toEqual({ ...base, repository, trigger });
  expect(
    v.parse(ExecutionContext, { version: 1, engine: "fake", mode: "plan" }),
  ).toEqual({ version: 1, engine: "fake" });
});

test("each trigger kind carries only its own values, and repository Runs need one", () => {
  const web = v.parse(ExecutionContext, {
    ...base,
    repository,
    trigger: { kind: "web.message" },
  });
  expect(triggerIssue("trigger" in web ? web.trigger : undefined)).toBe(
    undefined,
  );
  for (const invalid of [
    { ...base, repository },
    { ...base, repository, trigger: { kind: "web.message", issueNumber: 8 } },
    {
      ...base,
      repository,
      trigger: { kind: "github.issue-label", issueNumber: 8 },
    },
    { ...base, repository, trigger: { kind: "unknown" } },
  ])
    expect(v.safeParse(ExecutionContext, invalid).success).toBe(false);
  expect(v.safeParse(ExecutionContext, base).success).toBe(true);
});

test("stored contexts keep reading after the network setting was removed", () => {
  const trigger = { kind: "web.message" };
  for (const agentNetworkAccess of [true, false])
    expect(
      v.parse(ExecutionContext, {
        ...base,
        repository: { ...repository, agentNetworkAccess },
        trigger,
      }),
    ).toEqual({ ...base, repository, trigger });
  expect(
    v.parse(ExecutionContext, {
      ...base,
      mode: "plan",
      repository: { ...repository, issueNumber: 8, agentNetworkAccess: true },
    }),
  ).toEqual({
    ...base,
    repository,
    trigger: { kind: "github.issue-comment", issueNumber: 8 },
  });
});

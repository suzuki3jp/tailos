import { expect, test, vi } from "vitest";
import {
  continueSession,
  type ContinueSessionDeps,
  type SessionMessage,
} from "./continue-session.ts";
import { ProjectChanged } from "@/application/triggers/admit-trigger.ts";

const project = {
  project: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Project",
    repository: "owner/repo",
    repositoryId: 42,
    installationId: 19,
    maxRunMinutes: 5,
  },
  ownerId: "owner",
  revision: 3,
  updatedAt: 1,
};
// A plan Turn from an issue comment, with its Routine's instructions.
const previous = {
  version: 1,
  engine: "codex",
  connectionId: "codex/c42c7de5-938d-4f93-a6af-d43bb0e7b65c",
  model: "old-model",
  effort: "low",
  mode: "plan",
  instructions: "Plan the issue.",
  routine: {
    id: "00000000-0000-4000-8000-000000000002",
    revision: 1,
    projectRevision: 1,
  },
  repository: {
    repository: "owner/repo",
    repositoryId: 42,
    installationId: 19,
    defaultBranch: "main",
  },
  trigger: { kind: "github.issue-comment", issueNumber: 8 },
};
const input = {
  ownerId: "owner",
  projectId: project.project.id,
  sessionId: "session",
  requestId: crypto.randomUUID(),
  message: "Also cover the error case",
};

function deps(overrides: Partial<ContinueSessionDeps> = {}) {
  const sent: SessionMessage[] = [];
  return {
    sent,
    deps: {
      project: async () => project,
      codexConnected: async () => true,
      latestTurn: async () => JSON.stringify(previous),
      admitMessage: vi.fn(async (message: SessionMessage) => {
        sent.push(message);
        return { runId: "run" };
      }),
      ...overrides,
    } satisfies ContinueSessionDeps,
  };
}

test("the next Turn keeps the latest Turn's settings, with only the model and effort changeable", async () => {
  const kept = deps();
  expect(await continueSession(input, kept.deps)).toEqual({
    status: "started",
    runId: "run",
  });
  expect(kept.sent[0]).toMatchObject({
    projectRevision: 3,
    body: input.message,
    timeoutMs: 300_000,
  });
  expect(JSON.parse(kept.sent[0]!.executionContext)).toEqual(previous);

  const chosen = deps();
  await continueSession({ ...input, model: "new-model" }, chosen.deps);
  const { model: _model, effort: _effort, ...settings } = previous;
  // Planning stays read-only with its instructions.
  expect(JSON.parse(chosen.sent[0]!.executionContext)).toEqual({
    ...settings,
    model: "new-model",
  });
});

test("a Session that cannot continue says why, and a Project change is read again once", async () => {
  expect(
    await continueSession(input, deps({ project: async () => null }).deps),
  ).toEqual({ status: "not_found" });
  expect(
    await continueSession(input, deps({ latestTurn: async () => null }).deps),
  ).toEqual({ status: "not_found" });
  expect(
    await continueSession(
      input,
      deps({ codexConnected: async () => false }).deps,
    ),
  ).toEqual({ status: "codex_not_connected" });
  expect(
    await continueSession(
      input,
      deps({ admitMessage: async () => "busy" }).deps,
    ),
  ).toEqual({ status: "busy" });
  const admit = vi
    .fn<ContinueSessionDeps["admitMessage"]>()
    .mockRejectedValueOnce(new ProjectChanged("edited"))
    .mockResolvedValueOnce({ runId: "run" });
  expect(
    await continueSession(input, deps({ admitMessage: admit }).deps),
  ).toEqual({ status: "started", runId: "run" });
  expect(admit).toHaveBeenCalledTimes(2);
});

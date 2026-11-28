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
      connected: async () => true,
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
  await continueSession({ ...input, model: "gpt-5.5" }, chosen.deps);
  const { model: _model, effort: _effort, ...settings } = previous;
  // Planning keeps its instructions.
  expect(JSON.parse(chosen.sent[0]!.executionContext)).toEqual({
    ...settings,
    model: "gpt-5.5",
  });

  // A planning Turn saved with the removed read-only mode is continued with
  // the same permissions as any other.
  const stored = deps({
    latestTurn: async () => JSON.stringify({ ...previous, mode: "plan" }),
  });
  await continueSession(input, stored.deps);
  expect(JSON.parse(stored.sent[0]!.executionContext)).toEqual(previous);
});

test("the Session keeps its Model Provider, whose models and connection it checks", async () => {
  const claude = {
    ...previous,
    engine: "claude",
    connectionId: "claude/c42c7de5-938d-4f93-a6af-d43bb0e7b65c",
    model: "claude-sonnet-5-5",
  };
  const connected = vi.fn<ContinueSessionDeps["connected"]>(async () => true);
  const session = deps({
    latestTurn: async () => JSON.stringify(claude),
    connected,
  });
  await continueSession(
    { ...input, engine: "claude", model: "claude-opus-5-5", effort: "max" },
    session.deps,
  );
  expect(connected).toHaveBeenCalledWith("owner", "claude");
  expect(JSON.parse(session.sent[0]!.executionContext)).toMatchObject({
    engine: "claude",
    connectionId: claude.connectionId,
    model: "claude-opus-5-5",
    effort: "max",
  });

  const switched = deps({ latestTurn: async () => JSON.stringify(claude) });
  expect(
    await continueSession({ ...input, engine: "codex" }, switched.deps),
  ).toEqual({ status: "provider_fixed", engine: "claude" });
  expect(
    await continueSession({ ...input, model: "gpt-5.5" }, switched.deps),
  ).toEqual({ status: "unsupported_selection", error: "unsupported_model" });
  expect(
    await continueSession(
      input,
      deps({
        latestTurn: async () => JSON.stringify(claude),
        connected: async () => false,
      }).deps,
    ),
  ).toEqual({ status: "not_connected", engine: "claude" });
  expect(switched.sent).toEqual([]);
});

test("a Session that cannot continue says why, and a Project change is read again once", async () => {
  expect(
    await continueSession(input, deps({ project: async () => null }).deps),
  ).toEqual({ status: "not_found" });
  expect(
    await continueSession(input, deps({ latestTurn: async () => null }).deps),
  ).toEqual({ status: "not_found" });
  expect(
    await continueSession(input, deps({ connected: async () => false }).deps),
  ).toEqual({ status: "not_connected", engine: "codex" });
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

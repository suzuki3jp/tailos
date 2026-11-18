import { expect, test } from "vitest";
import * as v from "valibot";
import { ExecutionContext } from "@tailos/core/runner";
import { createTestDb } from "./testing.ts";
import { d1Projects } from "./projects.ts";
import { ProjectConflict } from "@/application/projects/store.ts";
import { admitTrigger } from "./trigger-admission.ts";
import { ProjectChanged } from "@/application/triggers/admit-trigger.ts";

const settings = {
  name: "Tailos",
  repository: "owner/repo",
  repositoryId: 42,
  installationId: 19,
  allowedActors: ["operator"],
  agentNetworkAccess: false,
  maxRunMinutes: 30,
};

test("atomic CRUD keeps revisions and audit history, blocks repository duplicates and does not reuse deleted identities", async (t) => {
  const db = await createTestDb(t);
  const store = d1Projects(db);
  const outcomes = await Promise.allSettled([
    store.create(settings, "operator"),
    store.create(settings, "operator"),
  ]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const [first] = await store.list();
  expect(first.project.id).toMatch(/^[0-9a-f-]{36}$/);
  await expect(store.create(settings, "operator")).rejects.toBeInstanceOf(
    ProjectConflict,
  );
  const updated = await store.update(
    first.project.id,
    1,
    { ...settings, agentNetworkAccess: true },
    "operator",
  );
  expect(updated?.revision).toBe(2);
  expect(
    await store.update(first.project.id, 1, settings, "operator"),
  ).toBeNull();
  expect(await store.remove(first.project.id, 1, "operator")).toBe(false);
  expect(await store.remove(first.project.id, 2, "operator")).toBe(true);
  expect(await store.list()).toEqual([]);
  const replacement = await store.create(settings, "operator");
  expect(replacement.project.id).not.toBe(first.project.id);
  const history = await store.history("operator");
  expect(history.changes.map((c) => c.operation)).toEqual([
    "create",
    "delete",
    "update",
    "create",
  ]);
  expect(history.changes[1]).toMatchObject({
    projectId: first.project.id,
    actorId: "operator",
    before: { agentNetworkAccess: true },
    after: null,
  });
  expect(history.changes[2]).toMatchObject({
    before: { agentNetworkAccess: false },
    after: { agentNetworkAccess: true },
  });
  await db
    .prepare(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON project_changes BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    )
    .run();
  await expect(
    store.update(
      replacement.project.id,
      1,
      { ...settings, name: "changed" },
      "operator",
    ),
  ).rejects.toThrow(/audit unavailable/);
  expect((await store.list())[0].project.name).toBe("Tailos");
});

test("enforces the 100 active project limit atomically and pages the complete history", async (t) => {
  const db = await createTestDb(t);
  const store = d1Projects(db);
  const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
  await db.batch(
    ids.map((id, index) =>
      db
        .prepare(
          "INSERT INTO projects (id, owner_id, name, repository_id, config, created_at, updated_at, updated_by) VALUES (?, 'operator', 'Tailos', ?, ?, 1, 1, 'operator')",
        )
        .bind(
          id,
          index + 1,
          JSON.stringify({ ...settings, id, repositoryId: index + 1 }),
        ),
    ),
  );
  await expect(
    store.create({ ...settings, repositoryId: 1000 }, "operator"),
  ).rejects.toBeInstanceOf(ProjectConflict);
  expect(await store.remove(ids[0], 1, "operator")).toBe(true);
  await store.create({ ...settings, repositoryId: 1000 }, "operator");
  expect(await store.list()).toHaveLength(100);
  const seen: number[] = [];
  let cursor: number | undefined;
  do {
    const page = await store.history("operator", cursor);
    seen.push(...page.changes.map((c) => c.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  expect(new Set(seen).size).toBe(102);
});

test("imports UUID mappings and session references once, preserving run snapshots and rolling back partial imports", async (t) => {
  const db = await createTestDb(t);
  const store = d1Projects(db);
  await db
    .prepare(
      "INSERT INTO sessions (id, owner_id, project_id, created_at) VALUES ('old', 'owner', 'meguri', 1), ('standalone', 'owner', NULL, 1), ('unmapped', 'owner', 'unknown', 1)",
    )
    .run();
  const project = {
    ...settings,
    name: settings.repository,
    id: crypto.randomUUID(),
  };
  await db
    .prepare(
      "CREATE TRIGGER reject_mapping BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'mapping failure'); END",
    )
    .run();
  await expect(store.import([project], ["meguri"], "operator")).rejects.toThrow(
    /mapping failure/,
  );
  expect(await store.list()).toEqual([]);
  expect((await store.history("operator")).changes).toEqual([]);
  expect(
    await db.prepare("SELECT count(*) AS n FROM project_imports").first("n"),
  ).toBe(0);
  await db.prepare("DROP TRIGGER reject_mapping").run();
  await store.import([project], ["meguri"], "operator");
  expect(
    await db
      .prepare("SELECT project_id FROM sessions WHERE id = 'old'")
      .first("project_id"),
  ).toBe(project.id);
  expect(
    await db
      .prepare("SELECT project_id FROM sessions WHERE id = 'standalone'")
      .first("project_id"),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT project_id FROM sessions WHERE id = 'unmapped'")
      .first("project_id"),
  ).toBe("unknown");
  expect(
    await db
      .prepare("SELECT legacy_id FROM projects WHERE id = ?")
      .bind(project.id)
      .first("legacy_id"),
  ).toBe("meguri");
  expect((await store.history("operator")).changes[0]).toMatchObject({
    operation: "import",
    projectId: project.id,
  });
  await expect(store.import([], [], "operator")).rejects.toBeInstanceOf(
    ProjectConflict,
  );
  await store.remove(project.id, 1, "operator");
  await expect(store.import([], [], "operator")).rejects.toBeInstanceOf(
    ProjectConflict,
  );
});

test("an empty import is also recorded and cannot be replayed", async (t) => {
  const store = d1Projects(await createTestDb(t));
  await store.import([], [], "operator");
  await expect(store.import([], [], "operator")).rejects.toBeInstanceOf(
    ProjectConflict,
  );
});

test("new trigger admission checks the project revision and deletion in its transaction", async (t) => {
  const db = await createTestDb(t);
  const store = d1Projects(db);
  const configured = await store.create(settings, "operator");
  const input = {
    source: "test",
    idempotencyKey: "delivery",
    ownerId: "operator",
    projectId: configured.project.id,
    projectRevision: 1,
    concurrencyKey: "target",
    prompt: "request",
    executionContext: JSON.stringify({
      engine: "codex",
      repository: { agentNetworkAccess: false },
    }),
    timeoutMs: 60_000,
  };
  await store.update(
    configured.project.id,
    1,
    { ...settings, agentNetworkAccess: true },
    "operator",
  );
  await expect(admitTrigger(db, input)).rejects.toBeInstanceOf(ProjectChanged);
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(0);
  const admitted = await admitTrigger(db, { ...input, projectRevision: 2 });
  await store.remove(configured.project.id, 2, "operator");
  expect(
    await db
      .prepare("SELECT status FROM runs WHERE id = ?")
      .bind(admitted.runId)
      .first("status"),
  ).toBe("queued");
  expect(
    await db
      .prepare("SELECT execution_context FROM runs WHERE id = ?")
      .bind(admitted.runId)
      .first("execution_context"),
  ).toBe(input.executionContext);
  await db
    .prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?")
    .bind(admitted.runId)
    .run();
  await expect(
    admitTrigger(db, {
      ...input,
      projectRevision: 3,
      idempotencyKey: "new-delivery",
    }),
  ).rejects.toBeInstanceOf(ProjectChanged);
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(1);
});

test("UUID import moves planning scopes atomically and preserves the existing conversation", async (t) => {
  const { acceptPlanningInput, dispatchPlanningInputs } =
    await import("./planning.ts");
  const db = await createTestDb(t);
  const store = d1Projects(db);
  const input = {
    ownerId: "operator",
    projectId: "meguri",
    repositoryId: 42,
    issueNumber: 3,
    commentId: 100,
    actor: "operator",
    url: "https://github.com/owner/repo/issues/3#issuecomment-100",
    body: "@tailos plan",
    deliveryId: "legacy-plan",
    start: true,
    executionContext: JSON.stringify({
      version: 1,
      engine: "codex",
      mode: "plan",
      connectionId: `codex/${crypto.randomUUID()}`,
      repository: {
        repository: settings.repository,
        repositoryId: 42,
        installationId: 19,
        agentNetworkAccess: false,
        issueNumber: 3,
        defaultBranch: "main",
      },
    }),
    timeoutMs: 60_000,
  };
  const receipt = await acceptPlanningInput(db, input);
  expect(await dispatchPlanningInputs(db)).toEqual([]);
  const project = {
    ...settings,
    name: settings.repository,
    id: crypto.randomUUID(),
  };
  await db
    .prepare(
      "CREATE TRIGGER reject_scope BEFORE UPDATE ON planning_inbox BEGIN SELECT RAISE(ABORT, 'scope failure'); END",
    )
    .run();
  await expect(store.import([project], ["meguri"], "operator")).rejects.toThrow(
    /scope failure/,
  );
  expect(await store.list()).toEqual([]);
  expect(
    await db
      .prepare("SELECT project_id FROM sessions WHERE id = ?")
      .bind(receipt.sessionId)
      .first("project_id"),
  ).toBe("meguri");
  await db.prepare("DROP TRIGGER reject_scope").run();
  await store.import([project], ["meguri"], "operator");
  const scope = JSON.stringify(["operator", project.id, 42, 3]);
  expect(
    await db.prepare("SELECT scope FROM planning_issues").first("scope"),
  ).toBe(scope);
  expect(
    await db.prepare("SELECT scope FROM planning_inbox").first("scope"),
  ).toBe(scope);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  expect(
    await acceptPlanningInput(db, {
      ...input,
      projectId: project.id,
      projectRevision: 1,
    }),
  ).toEqual(receipt);
  await store.update(
    project.id,
    1,
    { ...settings, maxRunMinutes: 2, agentNetworkAccess: true },
    "operator",
  );
  const [runId] = await dispatchPlanningInputs(db);
  expect(runId).toBeTruthy();
  const run = await db
    .prepare(
      "SELECT execution_context, deadline_at, created_at FROM runs WHERE id = ?",
    )
    .bind(runId)
    .first<{
      execution_context: string;
      deadline_at: number;
      created_at: number;
    }>();
  const context = v.parse(ExecutionContext, JSON.parse(run!.execution_context));
  expect(
    context.engine === "codex" && context.repository?.agentNetworkAccess,
  ).toBe(true);
  expect(run!.deadline_at - run!.created_at).toBe(120_000);
  await acceptPlanningInput(db, {
    ...input,
    projectId: project.id,
    projectRevision: 2,
    deliveryId: "follow-up",
    commentId: 101,
  });
  await store.remove(project.id, 2, "operator");
  await db
    .prepare("UPDATE runs SET status = 'failed' WHERE id = ?")
    .bind(runId)
    .run();
  expect(await dispatchPlanningInputs(db)).toEqual([]);
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT count(*) AS n FROM planning_inbox WHERE state = 'pending'",
      )
      .first("n"),
  ).toBe(1);
});

test("planning admission rejects a stale or deleted project without accepting another comment", async (t) => {
  const { acceptPlanningInput } = await import("./planning.ts");
  const db = await createTestDb(t);
  const store = d1Projects(db);
  const configured = await store.create(settings, "operator");
  const input = {
    ownerId: "operator",
    projectId: configured.project.id,
    projectRevision: 1,
    repositoryId: 42,
    issueNumber: 3,
    commentId: 100,
    actor: "operator",
    url: "https://github.com/owner/repo/issues/3#issuecomment-100",
    body: "@tailos plan",
    deliveryId: "plan",
    start: true,
    executionContext: "{}",
    timeoutMs: 60_000,
  };
  await store.update(configured.project.id, 1, settings, "operator");
  await expect(acceptPlanningInput(db, input)).rejects.toBeInstanceOf(
    ProjectChanged,
  );
  expect(
    await db.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(0);
  await acceptPlanningInput(db, { ...input, projectRevision: 2 });
  await store.remove(configured.project.id, 2, "operator");
  await expect(
    acceptPlanningInput(db, {
      ...input,
      projectRevision: 2,
      commentId: 101,
      deliveryId: "new",
    }),
  ).rejects.toBeInstanceOf(ProjectChanged);
  expect(
    await db.prepare("SELECT count(*) AS n FROM planning_inbox").first("n"),
  ).toBe(1);
});

test("owner and planning scope mismatches remain distinct from project revision conflicts", async (t) => {
  const { acceptPlanningInput } = await import("./planning.ts");
  const db = await createTestDb(t);
  const store = d1Projects(db);
  const configured = await store.create(settings, "operator");
  const trigger = {
    source: "test",
    ownerId: "operator",
    projectId: configured.project.id,
    projectRevision: 1,
    idempotencyKey: "delivery",
    concurrencyKey: "target",
    prompt: "request",
    executionContext: "{}",
    timeoutMs: 60_000,
  };
  await admitTrigger(db, trigger);
  await expect(
    admitTrigger(db, { ...trigger, ownerId: "other" }),
  ).rejects.toThrow("original owner");
  await expect(
    admitTrigger(db, { ...trigger, ownerId: "other" }),
  ).rejects.not.toBeInstanceOf(ProjectChanged);
  const planning = {
    ownerId: "operator",
    projectId: configured.project.id,
    projectRevision: 1,
    repositoryId: 42,
    issueNumber: 3,
    commentId: 100,
    actor: "operator",
    url: "https://github.com/owner/repo/issues/3#issuecomment-100",
    body: "@tailos plan",
    deliveryId: "planning",
    start: true,
    executionContext: "{}",
    timeoutMs: 60_000,
  };
  await acceptPlanningInput(db, planning);
  await expect(
    acceptPlanningInput(db, { ...planning, ownerId: "other" }),
  ).rejects.toThrow("original scope");
  await expect(
    acceptPlanningInput(db, { ...planning, ownerId: "other" }),
  ).rejects.not.toBeInstanceOf(ProjectChanged);
});

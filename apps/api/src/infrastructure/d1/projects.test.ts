import { expect, test } from "vitest";
import { createTestDb } from "./testing.ts";
import { d1Projects } from "./projects.ts";
import { ProjectConflict } from "@/application/projects/store.ts";
import { admitTrigger } from "./trigger-admission.ts";
import { ProjectChanged } from "@/application/triggers/admit-trigger.ts";
import { d1Routines } from "./routines.ts";
import { planningPrompt } from "@/application/routines/routines.ts";

const settings = {
  name: "Tailos",
  repository: "owner/repo",
  repositoryId: 42,
  installationId: 19,
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
    { ...settings, maxRunMinutes: 10 },
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
    before: { maxRunMinutes: 10 },
    after: null,
  });
  expect(history.changes[2]).toMatchObject({
    before: { maxRunMinutes: 30 },
    after: { maxRunMinutes: 10 },
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
    allowedActors: ["operator"],
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
    { ...settings, maxRunMinutes: 10 },
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

test("import gives each Project a plan Routine for the users who could start plans", async (t) => {
  const db = await createTestDb(t);
  const store = d1Projects(db);
  const project = {
    ...settings,
    name: settings.repository,
    id: crypto.randomUUID(),
    allowedActors: ["planner"],
  };
  await store.import([project], ["meguri"], "operator");
  const [stored] = await store.list();
  expect(stored.project).not.toHaveProperty("allowedActors");
  const routines = await d1Routines(db).list("operator", project.id);
  expect(routines).toEqual([
    expect.objectContaining({
      name: "Issue planning",
      enabled: true,
      trigger: { version: 1, type: "github.issue-comment", command: "plan" },
      allowedActors: ["planner"],
      prompt: planningPrompt,
    }),
  ]);
});

test("stored projects and history that still carry the removed network setting stay readable", async (t) => {
  const db = await createTestDb(t);
  const store = d1Projects(db);
  const created = await store.create(settings, "operator");
  const { name: _name, ...config } = created.project;
  const legacy = JSON.stringify({ ...config, agentNetworkAccess: true });
  await db
    .prepare("UPDATE projects SET config = ? WHERE id = ?")
    .bind(legacy, created.project.id)
    .run();
  const [stored] = await store.list();
  expect(stored.project).toEqual(created.project);
  expect(stored.project).not.toHaveProperty("agentNetworkAccess");
  // The audit trigger stored the legacy configuration; history is not rewritten.
  const [change] = (await store.history("operator")).changes;
  expect(change?.after).toEqual(created.project);
  expect(
    await db
      .prepare("SELECT after_config FROM project_changes ORDER BY id DESC")
      .first("after_config"),
  ).toContain("agentNetworkAccess");
  expect(
    await db
      .prepare("SELECT config FROM projects WHERE id = ?")
      .bind(created.project.id)
      .first("config"),
  ).toBe(legacy);
  await expect(
    store.update(
      created.project.id,
      1,
      { ...settings, agentNetworkAccess: true } as typeof settings,
      "operator",
    ),
  ).rejects.toThrow();
});

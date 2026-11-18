import { expect, test } from "vitest";
import { createTestDb, createTestBindings } from "./testing.ts";
import { d1Projects } from "./projects.ts";
import { d1Routines, replayLabelDelivery } from "./routines.ts";
import { admitTrigger } from "./trigger-admission.ts";
import { dispatchIssueLabel } from "@/application/routines/dispatch-label.ts";
import {
  implementationPrompt,
  type RoutineSettings,
} from "@/application/routines/routines.ts";
const owner = "00000000-0000-4000-8000-000000000001";
const settings = {
  name: "Project",
  repository: "owner/repo",
  repositoryId: 42,
  installationId: 19,
  allowedActors: ["plan-user"],
  agentNetworkAccess: true,
  maxRunMinutes: 2,
};
const routineSettings: RoutineSettings = {
  name: "Build",
  enabled: true,
  trigger: { version: 1, type: "github.issue-label", label: "build" },
  allowedActors: ["builder"],
  engine: "codex",
  prompt: "Implement the issue and run the repository checks.",
  model: "test-model",
  effort: "high",
};
const event = {
  repository: { id: 42, full_name: "owner/repo", default_branch: "main" },
  installation: { id: 19 },
  issue: { number: 3, title: "Issue", body: "Body", state: "open" },
  label: { name: "build" },
  sender: { login: "builder" },
};
test("migration preserves label configuration as an enabled Routine and removes the Project label", async (t) => {
  const id = crypto.randomUUID();
  const deletedId = crypto.randomUUID();
  let originalHistory: unknown[] = [];
  const { DB } = await createTestBindings(t, {
    beforeMigration: async (db, file) => {
      if (!file.startsWith("0011_")) return;
      await db
        .prepare(
          "INSERT INTO projects (id, name, owner_id, repository_id, config, created_at, updated_at, updated_by) VALUES (?, 'Project', ?, 42, ?, 1, 1, ?)",
        )
        .bind(
          id,
          owner,
          JSON.stringify({ ...settings, id, triggerLabel: "build" }),
          owner,
        )
        .run();
      await db
        .prepare(
          "INSERT INTO projects (id, name, owner_id, repository_id, config, created_at, updated_at, updated_by) VALUES (?, 'Deleted', ?, 43, ?, 1, 1, ?)",
        )
        .bind(
          deletedId,
          owner,
          JSON.stringify({
            ...settings,
            id: deletedId,
            repositoryId: 43,
            triggerLabel: "old",
          }),
          owner,
        )
        .run();
      await db
        .prepare(
          "UPDATE projects SET deleted_at = 2, updated_at = 2 WHERE id = ?",
        )
        .bind(deletedId)
        .run();
      originalHistory = (
        await db.prepare("SELECT * FROM project_changes ORDER BY id").all()
      ).results;
    },
  });
  expect(
    (await DB.prepare("SELECT * FROM project_changes ORDER BY id").all())
      .results,
  ).toEqual(originalHistory);
  expect(
    await DB.prepare("SELECT count(*) AS n FROM routines WHERE project_id = ?")
      .bind(deletedId)
      .first("n"),
  ).toBe(0);
  const [migrated] = (await d1Routines(DB).list(owner, id))!;
  expect(migrated).toMatchObject({
    id,
    enabled: true,
    trigger: { label: "build" },
    allowedActors: ["plan-user"],
    engine: "codex",
    prompt: implementationPrompt,
  });
  expect(
    JSON.parse(
      (await DB.prepare("SELECT config FROM projects WHERE id = ?")
        .bind(id)
        .first<string>("config"))!,
    ),
  ).not.toHaveProperty("triggerLabel");
  const changes = (await d1Routines(DB).history(owner, id))!.changes;
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ actorId: "migration:routines" });
  expect(changes[0].createdAt).toBeGreaterThan(2);
  const projects = d1Projects(DB);
  await projects.update(id, 1, { ...settings, name: "Edited" }, owner);
  const history = (
    await DB.prepare("SELECT * FROM project_changes ORDER BY id").all()
  ).results;
  expect(history).toHaveLength(originalHistory.length + 1);
  expect(history.at(-1)).toMatchObject({
    project_id: id,
    operation: "update",
    actor_id: owner,
  });
});
test("owned Routine CRUD uses revisions, retains deleted history, and rolls back settings when audit fails", async (t) => {
  const db = await createTestDb(t);
  const project = await d1Projects(db).create(settings, owner);
  const store = d1Routines(db);
  expect(await store.list("other", project.project.id)).toBeNull();
  const first = (await store.save(owner, project.project.id, routineSettings))!;
  expect(
    await store.save("other", project.project.id, routineSettings, {
      id: first.id,
      revision: 1,
    }),
  ).toBeNull();
  const second = (await store.save(
    owner,
    project.project.id,
    { ...routineSettings, name: "New" },
    { id: first.id, revision: 1 },
  ))!;
  expect(second.revision).toBe(2);
  expect(await store.remove(owner, project.project.id, first.id, 1)).toBe(
    false,
  );
  await db
    .prepare(
      "CREATE TRIGGER reject_routine_audit BEFORE INSERT ON routine_changes BEGIN SELECT RAISE(ABORT, 'audit_failed'); END",
    )
    .run();
  await expect(
    store.save(
      owner,
      project.project.id,
      { ...routineSettings, name: "Lost" },
      { id: first.id, revision: 2 },
    ),
  ).rejects.toThrow(/audit_failed/);
  expect((await store.list(owner, project.project.id))![0].name).toBe("New");
  await db.prepare("DROP TRIGGER reject_routine_audit").run();
  expect(await store.remove(owner, project.project.id, first.id, 2)).toBe(true);
  expect(await store.list(owner, project.project.id)).toEqual([]);
  expect(
    (await store.history(owner, project.project.id))!.changes.map(
      (c) => c.after?.name ?? null,
    ),
  ).toEqual([null, "New", "Build"]);
});
test("label dispatch isolates matching Routines, snapshots options, replays after deletion, and coalesces only within one Routine", async (t) => {
  const db = await createTestDb(t);
  const projects = d1Projects(db);
  const p = await projects.create(settings, owner);
  const store = d1Routines(db);
  const first = (await store.save(owner, p.project.id, routineSettings))!;
  const second = (await store.save(owner, p.project.id, {
    ...routineSettings,
    name: "Review",
    prompt: "Inspect the issue and summarize.",
  }))!;
  await store.save(owner, p.project.id, {
    ...routineSettings,
    name: "Disabled",
    enabled: false,
  });
  const deps = {
    projects: () => projects.list(),
    routines: (id: string) => store.candidates(id),
    replay: (id: string, ownerId: string) =>
      replayLabelDelivery(db, id, ownerId),
    admit: (input: Parameters<typeof admitTrigger>[1]) =>
      admitTrigger(db, input),
  };
  const send = (deliveryId: string, actor = "builder") =>
    dispatchIssueLabel(
      {
        event: { ...event, sender: { login: actor } },
        ownerId: owner,
        deliveryId,
      },
      deps,
    );
  expect((await send("unauthorized", "plan-user")).results).toEqual([]);
  const accepted = await send("one");
  expect(accepted.failed).toEqual([]);
  expect(accepted.results).toHaveLength(2);
  const runs = await db
    .prepare(
      "SELECT execution_context, deadline_at - created_at AS duration FROM runs",
    )
    .all<{ execution_context: string; duration: number }>();
  expect(runs.results.map((r) => JSON.parse(r.execution_context))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "test-model",
        effort: "high",
        routine: { id: first.id, revision: 1, projectRevision: 1 },
        repository: expect.objectContaining({
          triggerLabel: "build",
          agentNetworkAccess: true,
        }),
      }),
    ]),
  );
  expect(runs.results.every((r) => r.duration === 120_000)).toBe(true);
  expect(
    (await send("two")).results.every((r) => r.disposition === "coalesced"),
  ).toBe(true);
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(2);
  await store.remove(owner, p.project.id, first.id, 1);
  await store.remove(owner, p.project.id, second.id, 1);
  expect(await send("one")).toEqual(accepted);
});
test("a Routine change during coalescing creates neither an event nor a replacement Run", async (t) => {
  const db = await createTestDb(t);
  const projects = d1Projects(db);
  const p = await projects.create(settings, owner);
  const store = d1Routines(db);
  const routine = (await store.save(owner, p.project.id, routineSettings))!;
  const deps = {
    projects: () => projects.list(),
    routines: (id: string) => store.candidates(id),
    replay: (id: string, ownerId: string) =>
      replayLabelDelivery(db, id, ownerId),
    admit: (input: Parameters<typeof admitTrigger>[1]) =>
      admitTrigger(db, input),
  };
  await dispatchIssueLabel(
    { event, ownerId: owner, deliveryId: "first" },
    deps,
  );
  let changed = false;
  const result = await dispatchIssueLabel(
    { event, ownerId: owner, deliveryId: "racing" },
    {
      ...deps,
      admit: async (input) => {
        if (!changed) {
          changed = true;
          await store.save(
            owner,
            p.project.id,
            { ...routineSettings, enabled: false },
            { id: routine.id, revision: 1 },
          );
        }
        return admitTrigger(db, input);
      },
    },
  );
  expect(result).toEqual({ results: [], failed: [] });
  expect(
    await db.prepare("SELECT count(*) AS n FROM trigger_events").first("n"),
  ).toBe(1);
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(1);
});
test("partial failure can be retried without restarting accepted work and evaluates newly added Routines", async (t) => {
  const db = await createTestDb(t);
  const projects = d1Projects(db);
  const p = await projects.create(settings, owner);
  const store = d1Routines(db);
  const a = (await store.save(owner, p.project.id, routineSettings))!;
  const b = (await store.save(owner, p.project.id, {
    ...routineSettings,
    name: "Second",
  }))!;
  let fail = true;
  const deps = {
    projects: () => projects.list(),
    routines: (id: string) => store.candidates(id),
    replay: (id: string, ownerId: string) =>
      replayLabelDelivery(db, id, ownerId),
    admit: (input: Parameters<typeof admitTrigger>[1]) =>
      input.routineId === b.id && fail
        ? Promise.reject(new Error("storage"))
        : admitTrigger(db, input),
  };
  const input = { event, ownerId: owner, deliveryId: "delivery" };
  const partial = await dispatchIssueLabel(input, deps);
  expect(partial.failed).toEqual([b.id]);
  expect(partial.results.map((r) => r.routineId)).toEqual([a.id]);
  await store.save(owner, p.project.id, { ...routineSettings, name: "Added" });
  fail = false;
  const result = await dispatchIssueLabel(input, deps);
  expect(result.failed).toEqual([]);
  expect(result.results).toHaveLength(3);
  expect(result.results.find((r) => r.routineId === a.id)?.runId).toBe(
    partial.results[0].runId,
  );
});

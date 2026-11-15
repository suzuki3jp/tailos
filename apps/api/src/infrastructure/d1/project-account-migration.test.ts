import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createTestBindings } from "./testing.ts";
import { d1Projects } from "./projects.ts";

test("account migration preserves IDs, revisions, long repository names and existing audit snapshots", async (t) => {
  const { DB } = await createTestBindings(t, {
    migrationsThrough: "0008_project_settings.sql",
  });
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const repository = "owner/" + "r".repeat(110);
  const config = {
    repository,
    repositoryId: 1,
    installationId: 1,
    triggerLabel: "tailos",
    allowedActors: ["owner"],
    agentNetworkAccess: false,
    maxRunMinutes: 30,
  };
  await DB.batch(
    ids.map((id, index) =>
      DB.prepare(
        "INSERT INTO projects (id, repository_id, config, created_at, updated_at, updated_by, deleted_at) VALUES (?, ?, ?, 10, 20, 'previous-editor', ?)",
      ).bind(
        id,
        index + 1,
        JSON.stringify({ ...config, id, repositoryId: index + 1 }),
        index === 1 ? 30 : null,
      ),
    ),
  );
  const snapshots = (
    await DB.prepare("SELECT * FROM project_changes ORDER BY id").all()
  ).results;
  const migration = await readFile(
    new URL(
      "../../../migrations/0009_project_account_identity.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await DB.batch(
    migration
      .split("--> statement-breakpoint")
      .map((statement) => DB.prepare(statement)),
  );
  expect(
    (await DB.prepare("SELECT * FROM project_changes ORDER BY id").all())
      .results,
  ).toEqual(snapshots);
  expect(
    (
      await DB.prepare(
        "SELECT name, owner_id, revision, updated_at FROM projects",
      ).all()
    ).results,
  ).toEqual([
    { name: repository, owner_id: null, revision: 1, updated_at: 20 },
    { name: repository, owner_id: null, revision: 1, updated_at: 20 },
  ]);
  await DB.batch([
    DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('current', 'Current', 'current@example.test', 1, 1, 1), ('previous', 'Previous', 'previous@example.test', 1, 1, 1)",
    ),
    DB.prepare(
      "INSERT INTO auth_accounts (id, user_id, provider_id, account_id, created_at, updated_at) VALUES ('current-account', 'current', 'github', '123', 1, 1), ('previous-account', 'previous', 'github', '456', 1, 1)",
    ),
  ]);
  // Exercise the deployed assignment query against actual D1, including reruns
  // after changing the configured operator. Existing ownership must survive.
  const assign = (githubId: string) =>
    DB.prepare(
      "UPDATE projects SET owner_id = (SELECT user_id FROM auth_accounts WHERE provider_id = 'github' AND account_id = ?) WHERE owner_id IS NULL",
    )
      .bind(githubId)
      .run();
  await assign("123");
  await assign("456");
  expect(
    (await DB.prepare("SELECT owner_id FROM projects").all()).results,
  ).toEqual([{ owner_id: "current" }, { owner_id: "current" }]);
  expect(
    (await DB.prepare("SELECT * FROM project_changes ORDER BY id").all())
      .results,
  ).toEqual(snapshots);
  const store = d1Projects(DB);
  expect((await store.settings("current"))[0].project).toMatchObject({
    id: ids[0],
    name: repository,
  });
  expect((await store.history("current")).changes).toHaveLength(2);
  expect((await store.history("current")).changes[0].after?.name).toBe(
    repository,
  );
  expect(await store.settings("previous")).toEqual([]);
  const { id: _id, ...settings } = (await store.settings("current"))[0].project;
  await store.update(ids[0], 1, { ...settings, name: "New name" }, "current");
  expect((await store.history("current")).changes[0]).toMatchObject({
    before: { name: repository },
    after: { name: "New name" },
  });
  expect((await DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

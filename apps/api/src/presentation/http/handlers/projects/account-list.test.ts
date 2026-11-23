import * as v from "valibot";
import { Hono } from "hono";
import { expect, test, type TestContext } from "vitest";
import type { Bindings } from "@/bindings.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { testLoginBindings } from "@/infrastructure/auth/testing.ts";
import { createOperatorAuth } from "@/presentation/http/middlewares/operator.ts";
import { createProjectRoutes } from "./projects.ts";

const summarySchema = v.strictObject({
  id: v.string(),
  name: v.string(),
  repository: v.string(),
});
const pageSchema = v.strictObject({
  items: v.array(summarySchema),
  nextCursor: v.nullable(v.string()),
});
const readPage = async (response: Response) =>
  v.parse(pageSchema, await response.json());
const config = {
  repository: "owner/repo",
  repositoryId: 1,
  installationId: 1,
  allowedActors: ["owner"],
  maxRunMinutes: 30,
};
async function fixture(t: TestContext) {
  const DB = await createTestDb(t);
  const env = testLoginBindings(DB);
  const store = d1Projects(DB);
  const app = new Hono<{ Bindings: Bindings }>().route(
    "/v1/projects",
    createProjectRoutes(
      () => store,
      () => ({ list: async () => [], verify: async () => {} }),
      createOperatorAuth(async (_env, headers) => {
        const id = headers.get("X-Test-Owner");
        return id ? { user: { id } } : null;
      }),
    ),
  );
  const request = (path = "", owner = "owner-a", body?: unknown) =>
    app.request(
      `${env.TAILOS_PUBLIC_ORIGIN}/v1/projects${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "X-Test-Owner": owner,
          Origin: env.TAILOS_WEB_ORIGIN,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  return { DB, store, request };
}

test("account summaries page across duplicate and Unicode names without exposing other owners, deleted rows or settings", async (t) => {
  const { store, request } = await fixture(t);
  for (const [index, name] of [
    "同じ名前",
    "Alpha",
    "同じ名前",
    "Beta",
  ].entries())
    await store.create({ ...config, repositoryId: index + 1, name }, "owner-a");
  await store.create(
    { ...config, repositoryId: 10, name: "Private" },
    "owner-b",
  );
  const removed = await store.create(
    { ...config, repositoryId: 11, name: "Deleted" },
    "owner-a",
  );
  await store.remove(removed.project.id, 1, "owner-a");
  const seen: { id: string; name: string; repository: string }[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(
      `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}&ownerId=owner-b`,
    );
    expect(response.status).toBe(200);
    const page = await readPage(response);
    seen.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  expect(seen.map((item) => item.name)).toEqual([
    "Alpha",
    "Beta",
    "同じ名前",
    "同じ名前",
  ]);
  expect(seen[2].id < seen[3].id).toBe(true);
  expect(new Set(seen.map((item) => item.id)).size).toBe(4);
  for (const item of seen)
    expect(Object.keys(item).sort()).toEqual(["id", "name", "repository"]);
  expect(await (await request("", "empty-owner")).json()).toEqual({
    items: [],
    nextCursor: null,
  });
  expect((await request("", "")).status).toBe(401);
});

test("account list enforces page size defaults and rejects malformed limits and cursors", async (t) => {
  const { DB, request } = await fixture(t);
  await DB.batch(
    Array.from({ length: 65 }, (_, index) => {
      const id = crypto.randomUUID();
      return DB.prepare(
        "INSERT INTO projects (id, name, owner_id, repository_id, config, created_at, updated_at, updated_by) VALUES (?, 'Same', 'owner-a', ?, ?, 1, 1, 'owner-a')",
      ).bind(
        id,
        index + 1,
        JSON.stringify({ ...config, id, repositoryId: index + 1 }),
      );
    }),
  );
  expect((await readPage(await request())).items).toHaveLength(50);
  expect((await readPage(await request("?limit=100"))).items).toHaveLength(65);
  for (const query of [
    "limit=0",
    "limit=-1",
    "limit=101",
    "limit=1.5",
    "limit=abc",
    "limit=",
    "limit=Infinity",
    "cursor=",
    "cursor=bad!",
    "cursor=bm90LWpzb24",
    `cursor=${btoa(JSON.stringify({ version: 2, name: "Same", id: crypto.randomUUID() }))}`,
  ])
    expect((await request(`?${query}`)).status, query).toBe(400);
});

test("owned settings, updates, deletion and history are scoped to the authenticated account", async (t) => {
  const { store, request } = await fixture(t);
  const mine = await store.create({ ...config, name: "Mine" }, "owner-a");
  const other = await store.create(
    { ...config, repositoryId: 2, name: "Other" },
    "owner-b",
  );
  const ownSettings = v.parse(
    v.object({
      projects: v.array(v.object({ project: v.object({ id: v.string() }) })),
    }),
    await (await request("/settings")).json(),
  );
  expect(ownSettings.projects.map((item) => item.project.id)).toEqual([
    mine.project.id,
  ]);
  expect(
    (
      await request(`/${other.project.id}`, "owner-a", {
        ...config,
        name: "Stolen",
        revision: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (await request(`/${other.project.id}/delete`, "owner-a", { revision: 1 }))
      .status,
  ).toBe(409);
  const history = v.parse(
    v.object({ changes: v.array(v.object({ projectId: v.string() })) }),
    await (await request("/history")).json(),
  );
  expect(history.changes.map((item) => item.projectId)).toEqual([
    mine.project.id,
  ]);
  expect((await store.settings("owner-b"))[0]).toMatchObject({
    revision: 1,
    project: { name: "Other" },
  });
});

test("names are required, trimmed, bounded and may be duplicated", async (t) => {
  const { store, request } = await fixture(t);
  for (const name of [undefined, "", "  \n ", "a".repeat(101)]) {
    const response = await request("", "owner-a", { ...config, name });
    expect(response.status).toBe(400);
  }
  const created = await request("", "owner-a", {
    ...config,
    name: "  自由な名前  ",
  });
  expect(created.status).toBe(201);
  const item = v.parse(
    v.object({ project: v.object({ id: v.string(), name: v.string() }) }),
    await created.json(),
  );
  expect(item.project.name).toBe("自由な名前");
  expect(
    (
      await request("", "owner-a", {
        ...config,
        repositoryId: 2,
        name: "自由な名前",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await request("", "owner-a", {
        ...config,
        repositoryId: 3,
        name: "a".repeat(100),
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await request(`/${item.project.id}`, "owner-a", {
        ...config,
        name: "  新しい名前  ",
        revision: 1,
      })
    ).status,
  ).toBe(200);
  const history = await store.history("owner-a");
  expect(history.changes[0]).toMatchObject({
    before: { name: "自由な名前" },
    after: { name: "新しい名前" },
  });
});

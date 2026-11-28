import { assert, expect, test } from "vitest";
import app from "@/bootstrap/http.ts";
import { createLoginAuth } from "@/infrastructure/auth/login.ts";
import { createLoginSessionCookie } from "@/infrastructure/auth/session-cookie.ts";
import { testLoginBindings } from "@/infrastructure/auth/testing.ts";
import { seedGithubId, seedLocalDatabase } from "./local-seed.ts";
import { createTestDb } from "./testing.ts";
import { listDueRunIds } from "./run-recovery.ts";

test("seeded data is visible through ordinary browser authentication", async (t) => {
  const DB = await createTestDb(t);
  const env = {
    ...testLoginBindings(DB),
    TAILOS_PUBLIC_ORIGIN: "http://localhost:8787",
    TAILOS_WEB_ORIGIN: "http://localhost:3000",
    TAILOS_OPERATOR_GITHUB_ID: seedGithubId,
  };
  const ownerId = await seedLocalDatabase(DB);
  await DB.prepare("UPDATE projects SET name = ? WHERE name = ?")
    .bind("Renamed sample project", "Sample project")
    .run();
  expect(await seedLocalDatabase(DB)).toBe(ownerId);

  const auth = createLoginAuth(env);
  assert(auth);
  const { name, value } = await createLoginSessionCookie(auth, ownerId);
  const request = (path: string, cookie = `${name}=${value}`) =>
    app.request(
      `${env.TAILOS_PUBLIC_ORIGIN}/v1${path}`,
      { headers: { cookie } },
      env,
    );
  expect((await request("/projects", "")).status).toBe(401);
  expect((await request("/projects", `${name}=${value}bad`)).status).toBe(401);

  const projects = await request("/projects/settings");
  expect(projects.status).toBe(200);
  expect(await projects.json()).toMatchObject({
    projects: [
      { ownerId, project: { name: "Empty project" } },
      { ownerId, project: { name: "Renamed sample project" } },
    ],
  });

  const sessions = await request("/sessions");
  expect(sessions.status).toBe(200);
  const {
    items,
  }: {
    items: {
      id: string;
      project: { id: string };
      latestRun: { status: string };
    }[];
  } = await sessions.json();
  expect(items.map(({ latestRun }) => latestRun.status).sort()).toEqual([
    "failed",
    "succeeded",
  ]);
  const completed = items.find(
    ({ latestRun }) => latestRun.status === "succeeded",
  );
  assert(completed);
  const detail = await request(
    `/projects/${completed.project.id}/sessions/${completed.id}`,
  );
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({
    detail: { messages: [{ authorKind: "user" }, { authorKind: "agent" }] },
  });

  const routines = await request(`/projects/${completed.project.id}/routines`);
  expect(routines.status).toBe(200);
  expect(await routines.json()).toMatchObject({
    routines: [{ enabled: false }],
  });
  expect(await listDueRunIds(DB, Date.now())).toEqual([]);
});

test("a seed conflict rolls back the operator and earlier sample rows", async (t) => {
  const DB = await createTestDb(t);
  await DB.prepare(
    "CREATE TRIGGER reject_seed_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'seed conflict'); END",
  ).run();

  await expect(seedLocalDatabase(DB)).rejects.toThrow();
  expect(await DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(
    0,
  );
  expect(
    await DB.prepare("SELECT COUNT(*) AS n FROM projects").first("n"),
  ).toBe(0);
});

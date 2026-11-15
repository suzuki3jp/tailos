import * as v from "valibot";
import { projectSchema } from "@/application/triggers/projects.ts";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { createProjectRoutes } from "./projects.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { getOperatorSession } from "@/infrastructure/auth/login.ts";
import { createOperatorAuth } from "@/presentation/http/middlewares/operator.ts";
import type { Bindings } from "@/bindings.ts";

const settings = {
  name: "Tailos",
  repository: "owner/repo",
  repositoryId: 42,
  installationId: 19,
  triggerLabel: "tailos:run",
  allowedActors: ["operator"],
};
test("operator-only CRUD and repository discovery enforce Origin, validation and server-side GitHub verification", async (t) => {
  const db = await createTestDb(t);
  const env = testLoginBindings(db);
  const operator = await createTestOperator(env);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  t.onTestFinished(() => warn.mockRestore());
  const verify = vi.fn(async (_target: unknown) => {});
  const list = vi.fn(async () => [
    { repository: "owner/repo", repositoryId: 42, installationId: 19 },
  ]);
  const app = new Hono<{ Bindings: Bindings }>().route(
    "/api/projects",
    createProjectRoutes(
      (env) => d1Projects(env.DB),
      () => ({ verify, list }),
      createOperatorAuth(getOperatorSession),
    ),
  );
  const send = (
    path = "",
    body?: unknown,
    headers: Record<string, string> = {
      Cookie: operator.cookie,
      Origin: env.TAILOS_WEB_ORIGIN,
    },
  ) =>
    app.request(
      `${env.TAILOS_PUBLIC_ORIGIN}/api/projects${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  for (const path of ["", "/repositories", "/history"])
    expect((await send(path, undefined, {})).status).toBe(401);
  for (const [path, body] of [
    ["", settings],
    ["/import", []],
    ["/00000000-0000-4000-8000-000000000000", { ...settings, revision: 1 }],
    ["/00000000-0000-4000-8000-000000000000/delete", { revision: 1 }],
  ] as const) {
    expect(
      (
        await send(path, body, {
          Cookie: operator.cookie,
          Origin: "https://other.example",
        })
      ).status,
    ).toBe(403);
    expect((await send(path, body, { Cookie: operator.cookie })).status).toBe(
      403,
    );
    expect(
      (await send(path, body, { Origin: env.TAILOS_WEB_ORIGIN })).status,
    ).toBe(401);
  }
  expect(verify).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect((await send("/repositories")).status).toBe(200);
  expect((await send("/history?before=bad")).status).toBe(400);
  for (const input of [
    { ...settings, id: crypto.randomUUID() },
    { ...settings, agent: "claude" },
    { ...settings, maxRunMinutes: 31 },
    { ...settings, allowedActors: [] },
    { ...settings, repositoryId: 0 },
  ])
    expect((await send("", input)).status).toBe(400);
  verify.mockRejectedValueOnce(new Error("private upstream details"));
  const failed = await send("", settings);
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private upstream details");
  expect(warn).toHaveBeenCalledWith(
    "Project request failed",
    expect.objectContaining({
      method: "POST",
      route: expect.any(String),
      errorName: "Error",
    }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain(
    "private upstream details",
  );
  expect(await d1Projects(db).list()).toEqual([]);
  const created = await send("", settings);
  expect(created.status).toBe(201);
  const item = v.parse(
    v.object({
      project: v.object({ ...projectSchema.entries, name: v.string() }),
      revision: v.number(),
    }),
    await created.json(),
  );
  expect(item).toMatchObject({
    project: { agentNetworkAccess: false, maxRunMinutes: 30 },
    revision: 1,
  });
  expect((await send("", settings)).status).toBe(409);
  expect(
    (
      await send(`/${item.project.id}`, {
        ...settings,
        revision: 1,
        agentNetworkAccess: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (await send(`/${item.project.id}`, { ...settings, revision: 1 })).status,
  ).toBe(409);
  expect(
    (await send(`/${item.project.id}/delete`, { revision: 2 })).status,
  ).toBe(200);
  expect(await (await send()).json()).toEqual({ items: [], nextCursor: null });
  const history = v.parse(
    v.object({ changes: v.array(v.object({ actorId: v.string() })) }),
    await (await send("/history")).json(),
  );
  expect(history.changes).toHaveLength(3);
  expect(
    history.changes.every(
      (c: { actorId: string }) => c.actorId === operator.id,
    ),
  ).toBe(true);
});

test("imports only valid unique legacy projects and verifies all GitHub targets before mutating", async (t) => {
  const db = await createTestDb(t);
  const env = testLoginBindings(db);
  const operator = await createTestOperator(env);
  const verify = vi.fn(async (_target: unknown) => {});
  const app = new Hono<{ Bindings: Bindings }>().route(
    "/api/projects",
    createProjectRoutes(
      (env) => d1Projects(env.DB),
      () => ({ verify, list: async () => [] }),
      createOperatorAuth(getOperatorSession),
    ),
  );
  const send = (body: unknown) =>
    app.request(
      `${env.TAILOS_PUBLIC_ORIGIN}/api/projects/import`,
      {
        method: "POST",
        headers: {
          Cookie: operator.cookie,
          Origin: env.TAILOS_WEB_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env,
    );
  const { name: _name, ...legacySettings } = settings;
  const legacy = { ...legacySettings, id: "meguri" };
  expect((await send([legacy, legacy])).status).toBe(400);
  expect((await send([legacy, { ...legacy, repositoryId: 43 }])).status).toBe(
    400,
  );
  verify
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("inaccessible repository"));
  expect(
    (await send([legacy, { ...legacy, id: "second", repositoryId: 43 }]))
      .status,
  ).toBe(503);
  expect(await d1Projects(db).list()).toEqual([]);
  const response = await send([legacy]);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    mapping: [
      { legacyId: "meguri", id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ],
  });
  expect((await send([legacy])).status).toBe(409);
});

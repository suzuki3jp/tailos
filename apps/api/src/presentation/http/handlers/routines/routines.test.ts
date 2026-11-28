import type { AgentConnected } from "@/application/auth/agent-connection.ts";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { createRoutineRoutes } from "./routines.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";
import { d1Routines } from "@/infrastructure/d1/routines.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { getOperatorSession } from "@/infrastructure/auth/login.ts";
import { createOperatorAuth } from "@/presentation/http/middlewares/operator.ts";
import type { Bindings } from "@/bindings.ts";
test("Routine API authenticates ownership and Origin, permits unverified disabled saves, and verifies activation", async (t) => {
  const DB = await createTestDb(t);
  const env = testLoginBindings(DB);
  const owner = await createTestOperator(env);
  const project = await d1Projects(DB).create(
    {
      name: "Project",
      repository: "owner/repo",
      repositoryId: 42,
      installationId: 19,
      maxRunMinutes: 30,
    },
    owner.id,
  );
  const connected = vi.fn<AgentConnected>(async () => false);
  const app = new Hono<{ Bindings: Bindings }>().route(
    "/projects/:projectId/routines",
    createRoutineRoutes(
      (env) => d1Routines(env.DB),
      () => connected,
      createOperatorAuth(getOperatorSession),
    ),
  );
  const path = `/projects/${project.project.id}/routines`;
  const settings = {
    name: "Build",
    enabled: false,
    trigger: { version: 1, type: "github.issue-label", label: "build" },
    allowedActors: ["builder"],
    prompt: "Implement the issue",
    engine: "codex",
    model: "gpt-5.5",
    effort: "high",
  };
  const send = (
    suffix = "",
    body?: unknown,
    headers: Record<string, string> = {
      Cookie: owner.cookie,
      Origin: env.TAILOS_WEB_ORIGIN,
    },
  ) =>
    app.request(
      `https://api.tailos.example${path}${suffix}`,
      {
        method: body ? "POST" : "GET",
        headers: { ...headers, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      },
      env,
    );
  expect((await send("", undefined, {})).status).toBe(401);
  expect(
    (
      await send("", settings, {
        Cookie: owner.cookie,
        Origin: "https://wrong.example",
      })
    ).status,
  ).toBe(403);
  expect((await send("", { ...settings, enabled: true })).status).toBe(503);
  for (const [body, status] of [
    ["{", 400],
    ["x".repeat(33 * 1024), 413],
  ] as const) {
    const invalid = await app.request(
      `https://api.tailos.example${path}`,
      {
        method: "POST",
        body,
        headers: {
          Cookie: owner.cookie,
          Origin: env.TAILOS_WEB_ORIGIN,
          "Content-Type": "application/json",
        },
      },
      env,
    );
    expect(invalid.status).toBe(status);
  }

  // Each Model Provider has its own models.
  expect((await send("", { ...settings, engine: "claude" })).status).toBe(400);
  expect((await send("", { ...settings, engine: "gemini" })).status).toBe(400);
  const claude = {
    ...settings,
    engine: "claude",
    model: "claude-opus-5-5",
    effort: "max",
  };
  expect((await send("", claude)).status).toBe(201);
  // Enabling checks the connection of the Routine's own provider.
  expect((await send("", { ...claude, enabled: true })).status).toBe(503);
  expect(connected).toHaveBeenLastCalledWith(owner.id, "claude");
  const created = await send("", settings);
  expect(created.status).toBe(201);
  const saved: { id: string; revision: number } = await created.json();
  expect(await d1Routines(DB).candidates(project.project.id)).toEqual([]);
  // The catalog is defined in source, so unknown values fail without a connection.
  expect((await send("", { ...settings, model: "wrong" })).status).toBe(400);
  expect((await send("", { ...settings, effort: "max" })).status).toBe(400);
  connected.mockResolvedValue(true);
  const defaultModel = { ...settings, model: undefined };
  // Codex may pick any default model, and not every model offers "max".
  expect((await send("", { ...defaultModel, effort: "max" })).status).toBe(201);
  expect(
    (await send("", { ...defaultModel, effort: "max", enabled: true })).status,
  ).toBe(503);
  expect(
    (await send(`/${saved.id}`, { ...settings, enabled: true, revision: 1 }))
      .status,
  ).toBe(200);
  expect(
    (await send(`/${saved.id}`, { ...settings, revision: 1 })).status,
  ).toBe(409);
  expect((await send("", { ...settings, model: "wrong" })).status).toBe(400);
  expect((await send("", { ...settings, effort: "unsupported" })).status).toBe(
    400,
  );
  expect((await send(`/history?before=0`)).status).toBe(400);
  expect((await send(`/history`)).status).toBe(200);
  await DB.prepare("UPDATE projects SET owner_id = 'other' WHERE id = ?")
    .bind(project.project.id)
    .run();
  expect((await send()).status).toBe(404);
  expect((await send("/history")).status).toBe(404);
  connected.mockClear();
  expect(
    (await send(`/${saved.id}`, { ...settings, enabled: true, revision: 2 }))
      .status,
  ).toBe(404);
  expect(connected).not.toHaveBeenCalled();
  expect((await send(`/${saved.id}/delete`, { revision: 2 })).status).toBe(409);
});

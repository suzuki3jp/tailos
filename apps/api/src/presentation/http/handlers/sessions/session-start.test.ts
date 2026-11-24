import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { ExecutionContext } from "@tailos/core/runner";
import * as v from "valibot";
import { createSessionRoutes } from "./sessions.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";
import { d1Sessions } from "@/infrastructure/d1/sessions.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import {
  admitSessionMessage,
  latestTurnContext,
} from "@/infrastructure/d1/session-inbox.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { getOperatorSession } from "@/infrastructure/auth/login.ts";
import { createOperatorAuth } from "@/presentation/http/middlewares/operator.ts";
import { initialSessionTitle } from "@/application/sessions/start-session.ts";
import type { Bindings } from "@/bindings.ts";

const settings = {
  name: "Project",
  repository: "owner/repo",
  repositoryId: 42,
  installationId: 19,
  maxRunMinutes: 3,
};

async function setup(t: import("vitest").TestContext) {
  const DB = await createTestDb(t);
  const env = testLoginBindings(DB);
  const owner = await createTestOperator(env);
  const project = await d1Projects(DB).create(settings, owner.id);
  const connected = vi.fn(async () => true);
  const defaultBranch = vi.fn(async () => "trunk");
  const scheduled: string[] = [];
  const { projectSessionRoutes } = createSessionRoutes(
    (env) => d1Sessions(env.DB),
    createOperatorAuth(getOperatorSession),
    {
      deps: (env) => ({
        project: async (ownerId, projectId) =>
          (await d1Projects(env.DB).settings(ownerId)).find(
            (record) => record.project.id === projectId,
          ) ?? null,
        codexConnected: connected,
        defaultBranch,
        admit: (input) => admitTrigger(env.DB, input),
      }),
      scheduleRun: () => async (id) => {
        scheduled.push(id);
      },
      continueDeps: (env) => ({
        project: async (ownerId, projectId) =>
          (await d1Projects(env.DB).settings(ownerId)).find(
            (record) => record.project.id === projectId,
          ) ?? null,
        codexConnected: connected,
        latestTurn: (input) => latestTurnContext(env.DB, input),
        admitMessage: (input) => admitSessionMessage(env.DB, input),
      }),
    },
  );
  const app = new Hono<{ Bindings: Bindings }>().route(
    "/projects/:projectId/sessions",
    projectSessionRoutes,
  );
  const send = (
    body: unknown,
    {
      projectId = project.project.id,
      headers = { Cookie: owner.cookie, Origin: env.TAILOS_WEB_ORIGIN },
      path = "",
    }: {
      projectId?: string;
      headers?: Record<string, string>;
      path?: string;
    } = {},
  ) =>
    app.request(
      `${env.TAILOS_PUBLIC_ORIGIN}/projects/${projectId}/sessions${path}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  return { DB, env, owner, project, connected, defaultBranch, scheduled, send };
}

test("a home message starts a Session and Run with the user's message, options and the Project's limits", async (t) => {
  const { DB, owner, project, defaultBranch, scheduled, send } = await setup(t);
  const requestId = crypto.randomUUID();
  const body = {
    requestId,
    message: "  Add a health check\nwith details  ",
    model: "gpt-5.5",
    effort: "high",
  };
  const response = await send(body);
  expect(response.status).toBe(201);
  const started = (await response.json()) as {
    sessionId: string;
    runId: string;
    projectId: string;
  };
  expect(started.projectId).toBe(project.project.id);
  expect(scheduled).toEqual([started.runId]);
  expect(defaultBranch).toHaveBeenCalledOnce();

  const session = await DB.prepare(
    "SELECT owner_id, project_id, title, target, trigger_metadata FROM sessions WHERE id = ?",
  )
    .bind(started.sessionId)
    .first();
  expect(session).toEqual({
    owner_id: owner.id,
    project_id: project.project.id,
    title: "Add a health check",
    target: JSON.stringify({
      version: 1,
      kind: "github.repository",
      repositoryId: 42,
    }),
    trigger_metadata: null,
  });
  expect(
    await DB.prepare(
      "SELECT author_kind, body FROM session_messages WHERE session_id = ?",
    )
      .bind(started.sessionId)
      .all(),
  ).toMatchObject({
    results: [
      { author_kind: "user", body: "Add a health check\nwith details" },
    ],
  });
  const run = await DB.prepare(
    "SELECT status, execution_context, deadline_at - created_at AS duration FROM runs WHERE id = ?",
  )
    .bind(started.runId)
    .first<{ status: string; execution_context: string; duration: number }>();
  expect(run?.status).toBe("queued");
  expect(run?.duration).toBe(180_000);
  expect(v.parse(ExecutionContext, JSON.parse(run!.execution_context))).toEqual(
    {
      version: 1,
      engine: "codex",
      connectionId: `codex/${owner.id}`,
      model: "gpt-5.5",
      effort: "high",
      repository: {
        repository: "owner/repo",
        repositoryId: 42,
        installationId: 19,
        defaultBranch: "trunk",
      },
      trigger: { kind: "web.message" },
    },
  );
  expect(
    await DB.prepare("SELECT count(*) AS n FROM issue_notifications").first(
      "n",
    ),
  ).toBe(0);

  // A resend of the same message returns the first Session instead of a new one.
  const again = await send(body);
  expect(again.status).toBe(201);
  expect(await again.json()).toMatchObject({
    sessionId: started.sessionId,
    runId: started.runId,
  });
  expect(
    await DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(1);

  // Each new message starts its own Session even while a Run is active.
  const other = await send({ requestId: crypto.randomUUID(), message: "Next" });
  expect(other.status).toBe(201);
  expect(
    await DB.prepare(
      "SELECT count(*) AS n FROM runs WHERE status = 'queued'",
    ).first("n"),
  ).toBe(2);
});

test("a home message is rejected without saving anything when it cannot start", async (t) => {
  const { DB, env, connected, defaultBranch, send } = await setup(t);
  const message = () => ({ requestId: crypto.randomUUID(), message: "Go" });

  expect(
    (await send(message(), { headers: { Origin: env.TAILOS_WEB_ORIGIN } }))
      .status,
  ).toBe(401);
  expect((await send(message(), { headers: {} })).status).toBe(403);
  for (const body of [
    { message: "Go" },
    { requestId: "not-a-uuid", message: "Go" },
    { ...message(), message: "   " },
    { ...message(), message: "x".repeat(4001) },
    { ...message(), extra: true },
  ])
    expect((await send(body)).status, JSON.stringify(body)).toBe(400);
  const unsupported = await send({ ...message(), model: "unknown-model" });
  expect(unsupported.status).toBe(400);
  expect(await unsupported.json()).toEqual({ error: "unsupported_model" });
  expect(
    (await send({ ...message(), model: "gpt-5.5", effort: "ultra" })).status,
  ).toBe(400);

  expect(
    (await send(message(), { projectId: crypto.randomUUID() })).status,
  ).toBe(404);

  connected.mockResolvedValueOnce(false);
  const disconnected = await send(message());
  expect(disconnected.status).toBe(409);
  expect(await disconnected.json()).toEqual({ error: "codex_not_connected" });

  defaultBranch.mockRejectedValueOnce(new Error("GitHub unavailable"));
  expect((await send(message())).status).toBe(503);

  expect(
    await DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(0);
});

test("a home message cannot start a Session in another account's Project", async (t) => {
  const { DB, send } = await setup(t);
  const other = await d1Projects(DB).create(
    { ...settings, repository: "other/repo", repositoryId: 43 },
    "other-owner",
  );
  expect(
    (
      await send(
        { requestId: crypto.randomUUID(), message: "Go" },
        { projectId: other.project.id },
      )
    ).status,
  ).toBe(404);
  expect(
    await DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(0);
});

test("the initial title is the first line within the title limit", () => {
  expect(initialSessionTitle("\n\n  First line \nsecond")).toBe("First line");
  expect(initialSessionTitle("a\tb")).toBe("a b");
  expect(initialSessionTitle("x".repeat(150))).toBe("x".repeat(100));
  expect(initialSessionTitle("😀".repeat(60))).toBe("😀".repeat(50));
  expect(initialSessionTitle("   ")).toBeUndefined();
});

test("the Session page sends the next message once the Session is idle, keeping its settings", async (t) => {
  const { DB, env, scheduled, send } = await setup(t);
  const started = (await (
    await send({
      requestId: crypto.randomUUID(),
      message: "Add a health check",
      model: "gpt-5.5",
      effort: "high",
    })
  ).json()) as { sessionId: string; runId: string };
  const path = `/${started.sessionId}/messages`;
  const message = { requestId: crypto.randomUUID(), message: "Also log it" };
  expect((await send({ ...message, message: " " }, { path })).status).toBe(400);
  expect(
    (await send(message, { path, headers: { Origin: env.TAILOS_WEB_ORIGIN } }))
      .status,
  ).toBe(401);
  const busy = await send(message, { path });
  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({ error: "session_busy" });
  await DB.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?")
    .bind(started.runId)
    .run();
  const response = await send(message, { path });
  expect(response.status).toBe(201);
  const { runId } = (await response.json()) as { runId: string };
  expect(scheduled).toEqual([started.runId, runId]);
  const run = await DB.prepare(
    "SELECT session_id, execution_context FROM runs WHERE id = ?",
  )
    .bind(runId)
    .first<{ session_id: string; execution_context: string }>();
  expect(run?.session_id).toBe(started.sessionId);
  expect(JSON.parse(run!.execution_context)).toMatchObject({
    model: "gpt-5.5",
    effort: "high",
    trigger: { kind: "web.message" },
  });
  expect(
    (
      await send(
        { requestId: crypto.randomUUID(), message: "x" },
        { path: `/${crypto.randomUUID()}/messages` },
      )
    ).status,
  ).toBe(404);
});

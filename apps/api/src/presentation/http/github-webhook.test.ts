import { createHmac } from "node:crypto";
import { assert, expect, test, vi } from "vitest";
import {
  createTestOperator,
  testLoginBindings,
} from "../../infrastructure/auth/testing.ts";
import { createTestDb } from "../../infrastructure/d1/testing.ts";
import app from "../../bootstrap/http.ts";

test("accepts a signed private issue event once and rejects unauthorized actors", async (t) => {
  const db = await createTestDb(t);
  const schedule = vi.fn(async (_id: string) => {
    throw new Error("Alarm unavailable");
  });
  const event = {
    action: "labeled",
    repository: {
      id: 42,
      full_name: "owner/private",
      default_branch: "main",
      private: true,
    },
    installation: { id: 19 },
    issue: {
      number: 8,
      state: "open",
      title: "Fix an issue",
      body: "Private issue details",
    },
    label: { name: "meguri:run" },
    sender: { login: "allowed-user" },
  };
  const env = {
    ...testLoginBindings(db),
    RUNNER: { getByName: () => ({ schedule }) },
    MEGURI_GH_WEBHOOK_SECRET: "test-secret",
    MEGURI_GH_APP_ID: "100",
    MEGURI_GH_APP_PRIVATE_KEY: "unused-until-run",
    PROJECTS: JSON.stringify([
      {
        id: "private-project",
        repository: "owner/private",
        repositoryId: 42,
        installationId: 19,
        triggerLabel: "meguri:run",
        allowedActors: ["allowed-user"],
      },
    ]),
  };
  const send = (payload: object, secret = env.MEGURI_GH_WEBHOOK_SECRET) => {
    const body = JSON.stringify(payload);
    return app.request(
      "https://meguri.example/webhooks/github",
      {
        method: "POST",
        body,
        headers: {
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "test-delivery",
          "X-Hub-Signature-256":
            "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
        },
      },
      env,
    );
  };

  expect((await send(event, "wrong-secret")).status).toBe(401);
  expect((await send({ ...event, sender: { login: "unknown" } })).status).toBe(
    204,
  );
  expect((await send({ ...event, installation: { id: 20 } })).status).toBe(204);
  expect(
    await db.prepare("SELECT count(*) AS count FROM runs").first("count"),
  ).toBe(0);

  const uninitialized = await send(event);
  expect(uninitialized.status).toBe(503);
  expect(
    await db.prepare("SELECT count(*) AS count FROM runs").first("count"),
  ).toBe(0);

  const operator = await createTestOperator(env);
  expect(schedule).not.toHaveBeenCalled();
  const accepted = await send(event);
  expect(accepted.status).toBe(202);
  const data = await accepted.json();
  assert(
    data && typeof data === "object" && "sessionId" in data && "runId" in data,
  );
  expect(await (await send(event)).json()).toStrictEqual(data);
  expect(schedule).toHaveBeenCalledTimes(2);
  expect(schedule).toHaveBeenCalledWith(data.runId);
  expect(
    await db
      .prepare("SELECT owner_id FROM sessions WHERE id = ?")
      .bind(data.sessionId)
      .first("owner_id"),
  ).toBe(operator.id);
  const run = await db
    .prepare("SELECT execution_context FROM runs WHERE id = ?")
    .bind(data.runId)
    .first<string>("execution_context");
  expect(JSON.parse(run ?? "null").connectionId).toBe(`codex/${operator.id}`);
  expect(
    await db.prepare("SELECT count(*) AS count FROM runs").first("count"),
  ).toBe(1);
  const path = `https://meguri.example/sessions/${data.sessionId}`;
  expect((await app.request(path, undefined, env)).status).toBe(303);
  const view = await app.request(
    path,
    {
      headers: { Cookie: operator.cookie },
    },
    env,
  );
  expect(view.status).toBe(200);
  expect(await view.text()).toMatch(/Private issue details/);
  await db
    .prepare("INSERT INTO sessions (id, owner_id, created_at) VALUES (?, ?, ?)")
    .bind("other-session", crypto.randomUUID(), Date.now())
    .run();
  const another = await app.request(
    "https://meguri.example/sessions/other-session",
    { headers: { Cookie: operator.cookie } },
    env,
  );
  expect(another.status).toBe(404);
});

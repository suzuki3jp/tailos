import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "vitest";
import { createTestOperator, testLoginBindings } from "../auth/testing.ts";
import { createTestDb } from "../db/testing.ts";
import app from "../index.ts";

test("accepts a signed private issue event once and rejects unauthorized actors", async (t) => {
  const db = await createTestDb(t);
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

  assert.equal((await send(event, "wrong-secret")).status, 401);
  assert.equal(
    (await send({ ...event, sender: { login: "unknown" } })).status,
    204,
  );
  assert.equal(
    (await send({ ...event, installation: { id: 20 } })).status,
    204,
  );
  assert.equal(
    await db.prepare("SELECT count(*) AS count FROM runs").first("count"),
    0,
  );

  const uninitialized = await send(event);
  assert.equal(uninitialized.status, 503);
  assert.equal(
    await db.prepare("SELECT count(*) AS count FROM runs").first("count"),
    0,
  );

  const operator = await createTestOperator(env);
  const accepted = await send(event);
  assert.equal(accepted.status, 202);
  const data = await accepted.json();
  assert.ok(
    data && typeof data === "object" && "sessionId" in data && "runId" in data,
  );
  assert.deepEqual(await (await send(event)).json(), data);
  assert.equal(
    await db
      .prepare("SELECT owner_id FROM sessions WHERE id = ?")
      .bind(data.sessionId)
      .first("owner_id"),
    operator.id,
  );
  const run = await db
    .prepare("SELECT execution_context FROM runs WHERE id = ?")
    .bind(data.runId)
    .first<string>("execution_context");
  assert.equal(JSON.parse(run ?? "null").connectionId, `codex/${operator.id}`);
  assert.equal(
    await db.prepare("SELECT count(*) AS count FROM runs").first("count"),
    1,
  );
  const path = `https://meguri.example/operator/sessions/${data.sessionId}`;
  assert.equal((await app.request(path, undefined, env)).status, 303);
  const view = await app.request(
    path,
    {
      headers: { Cookie: operator.cookie },
    },
    env,
  );
  assert.equal(view.status, 200);
  assert.match(await view.text(), /Private issue details/);
  await db
    .prepare("INSERT INTO sessions (id, owner_id, created_at) VALUES (?, ?, ?)")
    .bind("other-session", crypto.randomUUID(), Date.now())
    .run();
  const another = await app.request(
    "https://meguri.example/operator/sessions/other-session",
    { headers: { Cookie: operator.cookie } },
    env,
  );
  assert.equal(another.status, 404);
});

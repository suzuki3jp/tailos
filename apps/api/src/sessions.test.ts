import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "./db/testing.ts";
import app from "./index.ts";

test("a configured operator can create and read a standalone session in message order", async (t) => {
  const db = await createTestDb(t);

  const token = "local-test-credential";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const env = { DB: db, MEGURI_TEST_TOKEN: token };
  const path = "/_internal/sessions";
  const payload = {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: ["First", "Second"] }),
  };

  assert.equal((await app.request(path, payload, { DB: db })).status, 404);
  assert.equal(
    (
      await app.request(
        path,
        { ...payload, headers: { ...headers, Authorization: "Bearer wrong" } },
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (await app.request(path, { ...payload, body: '{"messages":[]}' }, env))
      .status,
    400,
  );
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM sessions").first("count"),
    0,
  );

  const response = await app.request(path, payload, env);
  assert.equal(response.status, 201);
  const { id } = await response.json();
  assert.equal(typeof id, "string");

  const detail = await app.request(`${path}/${id}`, { headers }, env);
  assert.equal(detail.status, 200);
  const { session, messages } = await detail.json();
  assert.equal(session.projectId, null);
  assert.equal(session.target, null);
  assert.deepEqual(
    messages.map((message: { body: string }) => message.body),
    ["First", "Second"],
  );

  await db
    .prepare("INSERT INTO sessions (id, owner_id, created_at) VALUES (?, ?, ?)")
    .bind("outside", "another-owner", 0)
    .run();
  assert.equal(
    (await app.request(`${path}/outside`, { headers }, env)).status,
    404,
  );
});

import { assert, expect, test } from "vitest";
import { createTestDb } from "../../infrastructure/d1/testing.ts";
import app from "../../bootstrap/http.ts";

test("a configured operator can create and read a standalone session in message order", async (t) => {
  const db = await createTestDb(t);

  const token = "local-test-credential";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const env = { DB: db, TAILOS_TEST_TOKEN: token };
  const path = "/_internal/sessions";
  const payload = {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: ["First", "Second"] }),
  };

  expect((await app.request(path, payload, { DB: db })).status).toBe(404);
  expect(
    (
      await app.request(
        path,
        { ...payload, headers: { ...headers, Authorization: "Bearer wrong" } },
        env,
      )
    ).status,
  ).toBe(401);
  expect(
    (await app.request(path, { ...payload, body: '{"messages":[]}' }, env))
      .status,
  ).toBe(400);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM sessions").first("count"),
  ).toBe(0);

  const response = await app.request(path, payload, env);
  expect(response.status).toBe(201);
  const created = await response.json();
  assert(created && typeof created === "object" && "id" in created);
  const { id } = created;
  assert(typeof id === "string");

  const detail = await app.request(`${path}/${id}`, { headers }, env);
  expect(detail.status).toBe(200);
  const data = await detail.json();
  assert(
    data && typeof data === "object" && "session" in data && "messages" in data,
  );
  const { session, messages } = data;
  assert(
    session &&
      typeof session === "object" &&
      "projectId" in session &&
      "target" in session,
  );
  assert(Array.isArray(messages));
  expect(session.projectId).toBe(null);
  expect(session.target).toBe(null);
  expect(
    messages.map((message: { body: string }) => message.body),
  ).toStrictEqual(["First", "Second"]);

  await db
    .prepare("INSERT INTO sessions (id, owner_id, created_at) VALUES (?, ?, ?)")
    .bind("outside", "another-owner", 0)
    .run();
  expect((await app.request(`${path}/outside`, { headers }, env)).status).toBe(
    404,
  );
});

import { assert, expect, test, type TestContext } from "vitest";
import app from "@/bootstrap/http.ts";
import { createTestBindings } from "@/infrastructure/d1/testing.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { d1McpKeys } from "@/infrastructure/d1/mcp-keys.ts";
import { issueMcpKey } from "@/application/auth/mcp-key.ts";

async function setup(t: TestContext) {
  const { DB } = await createTestBindings(t);
  const env = testLoginBindings(DB);
  const operator = await createTestOperator(env);
  const url = env.TAILOS_PUBLIC_ORIGIN + "/v1/mcp-keys";
  const headers = {
    Cookie: operator.cookie,
    Origin: env.TAILOS_WEB_ORIGIN,
    "Content-Type": "application/json",
  };
  const create = (json: object) =>
    app.request(
      url,
      { method: "POST", headers, body: JSON.stringify(json) },
      env,
    );
  const revoke = (id: string) =>
    app.request(url + "/" + id + "/revoke", { method: "POST", headers }, env);
  const mcp = (token: string) =>
    app.request(
      env.TAILOS_PUBLIC_ORIGIN + "/mcp",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_usage", arguments: {} },
        }),
      },
      env,
    );
  return { env, operator, url, headers, create, revoke, mcp };
}

test("a browser-issued key works immediately and its plaintext is never stored or listed; revocation is immediate", async (t) => {
  const f = await setup(t);
  const response = await f.create({
    name: "  Desktop agent  ",
    lifetimeDays: 7,
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const issued = await response.json();
  assert(
    issued &&
      typeof issued === "object" &&
      "token" in issued &&
      "key" in issued,
  );
  assert(
    typeof issued.token === "string" &&
      issued.key &&
      typeof issued.key === "object" &&
      "id" in issued.key &&
      typeof issued.key.id === "string",
  );
  expect(issued.token).toMatch(/^tailos_read_[A-Za-z0-9_-]{43}$/);
  expect(await (await f.mcp(issued.token)).text()).toContain(
    "Tailos read-only inspection",
  );
  const stored = await f.env.DB.prepare("SELECT * FROM mcp_keys").all();
  expect(JSON.stringify(stored)).not.toContain(issued.token);
  expect(stored.results[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(stored.results[0].name).toBe("Desktop agent");
  expect(
    Number(stored.results[0].expires_at) - Number(stored.results[0].created_at),
  ).toBe(7 * 86_400_000);
  const listing = await app.request(f.url, { headers: f.headers }, f.env);
  expect(listing.status).toBe(200);
  const listedText = await listing.text();
  expect(listedText).toContain("Desktop agent");
  expect(listedText).not.toContain(issued.token);
  expect(listedText).not.toContain("sha256");
  expect((await f.revoke(issued.key.id)).status).toBe(200);
  expect((await f.mcp(issued.token)).status).toBe(401);
  expect((await f.revoke(issued.key.id)).status).toBe(200);
  expect(await d1McpKeys(f.env.DB).list(f.operator.id)).toEqual([]);
});

test("key management requires the operator browser session and matching Origin, and cannot revoke another owner's key", async (t) => {
  const f = await setup(t);
  const store = d1McpKeys(f.env.DB);
  const key = await issueMcpKey(store, f.operator.id, "Own", 30);
  assert(key);
  for (const method of ["GET", "POST"]) {
    const response = await app.request(
      f.url,
      {
        method,
        headers: {
          Authorization: `Bearer ${key.token}`,
          Origin: f.env.TAILOS_WEB_ORIGIN,
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ name: "Injected" }) }
          : {}),
      },
      f.env,
    );
    expect(response.status).toBe(401);
  }
  for (const origin of ["https://other.example", ""]) {
    expect(
      (
        await app.request(
          f.url,
          {
            method: "POST",
            headers: { ...f.headers, Origin: origin },
            body: '{"name":"Denied"}',
          },
          f.env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          f.url + "/" + key.key.id + "/revoke",
          { method: "POST", headers: { ...f.headers, Origin: origin } },
          f.env,
        )
      ).status,
    ).toBe(403);
  }
  const outside = { id: crypto.randomUUID() };
  await f.env.DB.prepare(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Other', 'other@example.test', 1, 1, 1)",
  )
    .bind(outside.id)
    .run();
  const outsideKey = await issueMcpKey(store, outside.id, "Outside", 30);
  assert(outsideKey);
  expect((await f.revoke(outsideKey.key.id)).status).toBe(404);
  expect((await store.list(outside.id)).map((row) => row.id)).toEqual([
    outsideKey.key.id,
  ]);
  expect((await f.mcp(outsideKey.token)).status).toBe(401);
  for (const input of [
    { name: "" },
    { name: "x", lifetimeDays: 0 },
    { name: "x", lifetimeDays: 91 },
    { name: "x", ownerId: outside.id },
  ])
    expect((await f.create(input)).status).toBe(400);
  expect((await store.list(f.operator.id)).map((row) => row.id)).toEqual([
    key.key.id,
  ]);
});

test("concurrent issuance enforces the key limit and revocation frees a slot", async (t) => {
  const f = await setup(t);
  const responses = await Promise.all(
    Array.from({ length: 23 }, (_, index) =>
      f.create({ name: `Agent ${index}` }),
    ),
  );
  expect(responses.filter((response) => response.status === 201)).toHaveLength(
    20,
  );
  expect(responses.filter((response) => response.status === 409)).toHaveLength(
    3,
  );
  const keys = await d1McpKeys(f.env.DB).list(f.operator.id);
  await f.revoke(keys[0].id);
  expect((await f.create({ name: "Replacement" })).status).toBe(201);
});

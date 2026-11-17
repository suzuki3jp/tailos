import { expect, test } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import app from "@/bootstrap/http.ts";
import type { ConnectionStatus } from "@/application/auth/device.ts";

test("protects the device code and requires a POST from the Web origin to change connection state", async (t) => {
  const login = testLoginBindings(await createTestDb(t));
  const { id, cookie } = await createTestOperator(login);
  const origin = login.TAILOS_WEB_ORIGIN;
  const path = login.TAILOS_PUBLIC_ORIGIN + "/v1/connect";
  let status: ConnectionStatus = { state: "disconnected" };
  let starts = 0;
  const env = {
    ...login,
    CREDENTIAL_ENCRYPTION_KEY: "test-key",
    CREDENTIALS: {
      getByName: (name: string) => {
        expect(name).toBe(`codex/${id}`);
        return {
          async status() {
            return status;
          },
          async begin() {
            starts++;
            status = {
              state: "pending",
              userCode: "MY<CODE",
              verificationUrl: "https://auth.openai.com/codex/device",
            };
            return true;
          },
          async issueAccess() {
            return null;
          },
          async disconnect() {
            status = { state: "disconnected" };
          },
        };
      },
    },
  };

  expect((await app.request(path)).status).toBe(404);
  expect((await app.request(path, undefined, env)).status).toBe(401);
  const preflight = await app.request(
    path + "/start",
    {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    },
    env,
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  const foreign = await app.request(
    path,
    {
      headers: { Origin: "https://another.example", Cookie: cookie },
    },
    env,
  );
  expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(
    (
      await app.request(
        path + "/start",
        {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://another.example" },
        },
        env,
      )
    ).status,
  ).toBe(403);
  const unauthenticated = { method: "POST", headers: { Origin: origin } };
  expect(
    (await app.request(path + "/start", unauthenticated, env)).status,
  ).toBe(401);
  expect(starts).toBe(0);

  const headers = { Cookie: cookie, Origin: origin };
  const response = await app.request(
    path + "/start",
    { method: "POST", headers },
    env,
  );
  expect(response.status).toBe(200);
  expect(starts).toBe(1);
  const pending = await app.request(path, { headers }, env);
  expect(pending.status).toBe(200);
  expect(pending.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await pending.json()).toEqual(status);
  expect(
    (await app.request(path + "/disconnect", unauthenticated, env)).status,
  ).toBe(401);
  expect(status.state).toBe("pending");
  expect(
    (await app.request(path + "/disconnect", { method: "POST", headers }, env))
      .status,
  ).toBe(200);
  expect(status).toStrictEqual({ state: "disconnected" });
});

test("saves a pasted Claude token without ever returning it", async (t) => {
  const login = testLoginBindings(await createTestDb(t));
  const { id, cookie } = await createTestOperator(login);
  const origin = login.TAILOS_WEB_ORIGIN;
  const path = login.TAILOS_PUBLIC_ORIGIN + "/v1/connect/claude";
  const token = "sk-ant-oat01-" + "a".repeat(64);
  const saved: string[] = [];
  const connected = {
    state: "connected",
    savedAt: 1,
    expiresAt: 2,
    expiry: "valid",
  };
  const env = {
    ...login,
    CREDENTIAL_ENCRYPTION_KEY: "test-key",
    CREDENTIALS: {
      getByName: (name: string) => ({
        async claudeStatus() {
          expect(name).toBe(`claude/${id}`);
          return saved.length ? connected : { state: "disconnected" };
        },
        async saveClaudeToken(value: string) {
          expect(name).toBe(`claude/${id}`);
          if (saved.length) return false;
          saved.push(value);
          return true;
        },
        async disconnect() {
          expect(name).toBe(`claude/${id}`);
          saved.length = 0;
        },
      }),
    },
  };
  const headers = {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
  };
  const save = (body: string, init = headers) =>
    app.request(path, { method: "POST", headers: init, body }, env);

  expect((await app.request(path, undefined, env)).status).toBe(401);
  expect(
    (await save(JSON.stringify({ token }), { ...headers, Cookie: "" })).status,
  ).toBe(401);
  expect(
    (
      await save(JSON.stringify({ token }), {
        ...headers,
        Origin: "https://another.example",
      })
    ).status,
  ).toBe(403);
  for (const body of [
    "",
    "{}",
    JSON.stringify({ token: "sk-ant-api03-" + "a".repeat(64) }),
    JSON.stringify({ token: token + " " }),
    JSON.stringify({ token, extra: true }),
    JSON.stringify({ token: token + "a".repeat(5000) }),
  ]) {
    const rejected = await save(body);
    expect([400, 413]).toContain(rejected.status);
    expect(await rejected.text()).not.toContain("sk-ant-");
  }
  expect(saved).toStrictEqual([]);
  expect(await (await app.request(path, { headers }, env)).json()).toEqual({
    state: "disconnected",
  });

  const response = await save(JSON.stringify({ token }));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toStrictEqual({ ok: true });
  expect(saved).toStrictEqual([token]);
  const status = await app.request(path, { headers }, env);
  expect(status.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await status.json()).toStrictEqual(connected);

  const again = await save(JSON.stringify({ token }));
  expect(again.status).toBe(409);
  expect(await again.json()).toStrictEqual({ error: "already_connected" });

  expect(
    (
      await app.request(
        path + "/disconnect",
        { method: "POST", headers: { Origin: origin } },
        env,
      )
    ).status,
  ).toBe(401);
  expect(saved).toStrictEqual([token]);
  expect(
    (await app.request(path + "/disconnect", { method: "POST", headers }, env))
      .status,
  ).toBe(200);
  expect(saved).toStrictEqual([]);
});

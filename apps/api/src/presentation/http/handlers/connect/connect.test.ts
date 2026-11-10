import { expect, test } from "vitest";
import { createTestDb } from "../../../../infrastructure/d1/testing.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "../../../../infrastructure/auth/testing.ts";
import app from "../../../../bootstrap/http.ts";
import type { ConnectionStatus } from "../../../../application/auth/device.ts";

test("protects the device code and requires a POST from the Web origin to change connection state", async (t) => {
  const login = testLoginBindings(await createTestDb(t));
  const { id, cookie } = await createTestOperator(login);
  const origin = login.TAILOS_WEB_ORIGIN;
  const path = login.TAILOS_PUBLIC_ORIGIN + "/api/connect";
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

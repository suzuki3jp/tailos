import { expect, test } from "vitest";
import { createTestDb } from "../../../../infrastructure/d1/testing.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "../../../../infrastructure/auth/testing.ts";
import app from "../../../../bootstrap/http.ts";
import type { ConnectionStatus } from "../../../../application/auth/device.ts";

test("protects the device code and requires a same-origin POST to change connection state", async (t) => {
  const login = testLoginBindings(await createTestDb(t));
  const { id, cookie } = await createTestOperator(login);
  const origin = login.MEGURI_PUBLIC_ORIGIN;
  const path = origin + "/connect";
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
  expect((await app.request(path, undefined, env)).status).toBe(303);
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
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("/connect");
  expect(starts).toBe(1);
  const pending = await app.request(path, { headers }, env);
  expect(pending.status).toBe(200);
  expect(pending.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(pending.headers.get("Content-Security-Policy")).toContain(
    "form-action 'self';",
  );
  expect(pending.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await pending.text()).toMatch(/MY&lt;CODE/);
  expect(
    (await app.request(path + "/disconnect", unauthenticated, env)).status,
  ).toBe(401);
  expect(status.state).toBe("pending");
  expect(
    (await app.request(path + "/disconnect", { method: "POST", headers }, env))
      .status,
  ).toBe(303);
  expect(status).toStrictEqual({ state: "disconnected" });
});

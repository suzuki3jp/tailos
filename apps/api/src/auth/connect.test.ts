import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestDb } from "../db/testing.ts";
import { createTestOperator, testLoginBindings } from "./testing.ts";
import app from "../index.ts";
import type { ConnectionStatus } from "./device.ts";

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
        assert.equal(name, `codex/${id}`);
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
          async disconnect() {
            status = { state: "disconnected" };
          },
        };
      },
    },
  };

  assert.equal((await app.request(path)).status, 404);
  assert.equal((await app.request(path, undefined, env)).status, 303);
  assert.equal(
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
    403,
  );
  assert.equal(starts, 0);

  const headers = { Cookie: cookie, Origin: origin };
  const response = await app.request(
    path + "/start",
    { method: "POST", headers },
    env,
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/connect");
  assert.equal(starts, 1);
  const pending = await app.request(path, { headers }, env);
  assert.equal(pending.status, 200);
  assert.equal(pending.headers.get("Cache-Control"), "private, no-store");
  assert.match(await pending.text(), /MY&lt;CODE/);
  assert.equal(
    (await app.request(path + "/disconnect", { method: "POST", headers }, env))
      .status,
    303,
  );
  assert.deepEqual(status, { state: "disconnected" });
});

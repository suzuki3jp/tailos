import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../index.ts";
import type { ConnectionStatus } from "./device.ts";

test("protects the device code and requires a same-origin POST to change connection state", async () => {
  const origin = "https://meguri.example";
  const path = origin + "/connect";
  const auth = "Basic " + btoa("meguri:operator-token");
  let status: ConnectionStatus = { state: "disconnected" };
  let starts = 0;
  const env = {
    MEGURI_OPERATOR_TOKEN: "operator-token",
    CREDENTIAL_ENCRYPTION_KEY: "test-key",
    CREDENTIALS: {
      getByName: () => ({
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
      }),
    },
  };

  assert.equal((await app.request(path)).status, 404);
  assert.equal((await app.request(path, undefined, env)).status, 401);
  assert.equal(
    (
      await app.request(
        path + "/start",
        {
          method: "POST",
          headers: { Authorization: auth, Origin: "https://another.example" },
        },
        env,
      )
    ).status,
    403,
  );
  assert.equal(starts, 0);

  const headers = { Authorization: auth, Origin: origin };
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

import assert from "node:assert/strict";
import { test } from "vitest";
import { createTestDb } from "../db/testing.ts";
import app from "../index.ts";
import { admitTrigger } from "../trigger-admission.ts";
import { newRunLease } from "./run-lease.ts";

test("a refresh request reaches the run's lease verifier only for active runs", async (t) => {
  const db = await createTestDb(t);
  const { runId } = await admitTrigger(db, {
    source: "test",
    idempotencyKey: "delivery",
    concurrencyKey: "target",
    ownerId: "owner",
    timeoutMs: 60_000,
    prompt: "Test",
    executionContext:
      '{"version":1,"engine":"codex","connectionId":"codex/default"}',
  });
  const bearer = newRunLease();
  const accessVersion = crypto.randomUUID();
  let verifications = 0;
  const env = {
    DB: db,
    RUNNER: {
      getByName(name: string) {
        assert.equal(name, runId);
        return {
          async refreshAccess(id: string, candidate: string, version: string) {
            verifications++;
            assert.equal(id, runId);
            assert.equal(version, accessVersion);
            return candidate === bearer ? { accessToken: "fresh" } : null;
          },
        };
      },
    },
  };
  const request = (token: string) =>
    app.request(
      `/_runner/runs/${runId}/credentials`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "X-Meguri-Access-Version": accessVersion,
        },
      },
      env,
    );

  assert.equal((await request(bearer)).status, 401);
  assert.equal(verifications, 0);
  await db
    .prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .bind(runId)
    .run();
  assert.equal((await request("malformed")).status, 401);
  assert.equal(verifications, 0);
  assert.equal((await request(newRunLease())).status, 401);
  const authorized = await request(bearer);
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await authorized.json(), { accessToken: "fresh" });
  await db
    .prepare("UPDATE runs SET deadline_at = 1 WHERE id = ?")
    .bind(runId)
    .run();
  assert.equal((await request(bearer)).status, 401);
  assert.equal(verifications, 2);
});

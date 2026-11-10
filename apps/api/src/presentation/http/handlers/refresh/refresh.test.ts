import { expect, test } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import app from "@/bootstrap/http.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { newRunLease } from "@/infrastructure/auth/run-lease.ts";

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
      '{"version":1,"engine":"codex","connectionId":"codex/c42c7de5-938d-4f93-a6af-d43bb0e7b65c"}',
  });
  const bearer = newRunLease();
  const accessVersion = crypto.randomUUID();
  let verifications = 0;
  const env = {
    DB: db,
    RUNNER: {
      getByName(name: string) {
        expect(name).toBe(runId);
        return {
          async refreshAccess(id: string, candidate: string, version: string) {
            verifications++;
            expect(id).toBe(runId);
            expect(version).toBe(accessVersion);
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
          "X-Tailos-Access-Version": accessVersion,
        },
      },
      env,
    );

  expect((await request(bearer)).status).toBe(401);
  expect(verifications).toBe(0);
  await db
    .prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .bind(runId)
    .run();
  expect((await request("malformed")).status).toBe(401);
  expect(verifications).toBe(0);
  expect((await request(newRunLease())).status).toBe(401);
  const authorized = await request(bearer);
  expect(authorized.status).toBe(200);
  expect(authorized.headers.get("Cache-Control")).toBe("no-store");
  expect(await authorized.json()).toStrictEqual({ accessToken: "fresh" });
  await db
    .prepare("UPDATE runs SET deadline_at = 1 WHERE id = ?")
    .bind(runId)
    .run();
  expect((await request(bearer)).status).toBe(401);
  expect(verifications).toBe(2);
});

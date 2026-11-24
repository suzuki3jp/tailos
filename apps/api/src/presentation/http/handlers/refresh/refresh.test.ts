import { expect, test } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import app from "@/bootstrap/http.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { newRunLease } from "@/infrastructure/auth/run-lease.ts";

test("the Runner cannot obtain model credentials: the egress Worker adds them", async (t) => {
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
  await db
    .prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .bind(runId)
    .run();
  const response = await app.request(
    `/_runner/runs/${runId}/credentials`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + newRunLease(),
        "X-Tailos-Access-Version": crypto.randomUUID(),
      },
    },
    { DB: db, RUNNER: {} },
  );
  expect(response.status).toBe(404);
});

test("hands a publication to the Run's Session and answers with what GitHub made or why not", async (t) => {
  const db = await createTestDb(t);
  const { runId, sessionId } = await admitTrigger(db, {
    source: "test",
    idempotencyKey: "publish",
    concurrencyKey: "target",
    ownerId: "owner",
    timeoutMs: 60_000,
    prompt: "Test",
    executionContext:
      '{"version":1,"engine":"codex","connectionId":"codex/c42c7de5-938d-4f93-a6af-d43bb0e7b65c"}',
  });
  await db
    .prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .bind(runId)
    .run();
  const work = {
    branch: `tailos/session/${sessionId}`,
    parentSha: "a".repeat(40),
    tree: "b".repeat(40),
    headline: "feat: add the feature",
    changes: { additions: [], deletions: [{ path: "old.ts" }] },
  };
  const answers: unknown[] = [
    { sha: "c".repeat(40), url: "https://github.com/owner/repo/pull/1" },
    { error: "pull_request_merged" },
  ];
  const sessions: string[] = [];
  const RUNNER = {
    getByName(name: string) {
      sessions.push(name);
      return { publishWork: async () => answers.shift() };
    },
  };
  const publish = (body: unknown) =>
    app.request(
      `/_runner/runs/${runId}/publish`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + newRunLease(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      { DB: db, RUNNER },
    );
  const published = await publish(work);
  expect(published.status).toBe(200);
  expect(await published.json()).toEqual({
    sha: "c".repeat(40),
    url: "https://github.com/owner/repo/pull/1",
  });
  const merged = await publish(work);
  expect(merged.status).toBe(409);
  expect(await merged.json()).toEqual({ error: "pull_request_merged" });
  // Work that is not checked never reaches the Session.
  const invalid = await publish({ ...work, headline: "Not a headline" });
  expect(invalid.status).toBe(400);
  expect(sessions).toEqual([sessionId, sessionId]);
});

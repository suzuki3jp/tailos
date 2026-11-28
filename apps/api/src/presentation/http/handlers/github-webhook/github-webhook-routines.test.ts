import { createHmac } from "node:crypto";
import { expect, test, vi } from "vitest";
import app from "@/bootstrap/http.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";
import { d1Routines } from "@/infrastructure/d1/routines.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { githubIssueDigest } from "@tailos/core/runner";

test("signed label webhook runs the saved Routine with the Project settings", async (t) => {
  const db = await createTestDb(t);
  const login = testLoginBindings(db);
  const owner = await createTestOperator(login);
  const project = await d1Projects(db).create(
    {
      name: "Project",
      repository: "owner/private",
      repositoryId: 42,
      installationId: 19,
      maxRunMinutes: 3,
    },
    owner.id,
  );
  const routine = (await d1Routines(db).save(owner.id, project.project.id, {
    name: "Implement",
    enabled: true,
    engine: "codex",
    prompt: "Implement the issue identified by structured job context.",
    model: "test-model",
    effort: "high",
    trigger: { version: 1, type: "github.issue-label", label: "build" },
    allowedActors: ["builder"],
  }))!;
  const schedule = vi.fn(async () => {
    throw new Error("alarm unavailable");
  });
  const env = {
    ...login,
    RUNNER: { getByName: () => ({ schedule }) },
    TAILOS_GH_WEBHOOK_SECRET: "test-secret",
    TAILOS_GH_APP_ID: "100",
    TAILOS_GH_APP_PRIVATE_KEY: "unused",
  };
  const event = {
    action: "labeled",
    repository: {
      id: 42,
      full_name: "owner/private",
      default_branch: "main",
    },
    installation: { id: 19 },
    issue: {
      number: 3,
      title: "Private issue",
      body: "Private details",
      state: "open",
    },
    label: { name: "build" },
    sender: { login: "builder" },
  };
  const send = (
    payload: object,
    delivery = "one",
    secret = env.TAILOS_GH_WEBHOOK_SECRET,
  ) => {
    const body = JSON.stringify(payload);
    return app.request(
      "https://tailos.example/webhooks/github",
      {
        method: "POST",
        body,
        headers: {
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": delivery,
          "X-Hub-Signature-256":
            "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
        },
      },
      env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} },
    );
  };
  expect((await send(event, "wrong", "wrong-secret")).status).toBe(401);
  for (const payload of [
    { ...event, repository: { ...event.repository, id: 99 } },
    { ...event, label: { name: "other" } },
    { ...event, sender: { login: "plan-user" } },
    { ...event, installation: { id: 20 } },
    { ...event, issue: { ...event.issue, state: "closed" } },
    {
      ...event,
      issue: { ...event.issue, pull_request: { url: "https://example.com" } },
    },
  ])
    expect((await send(payload)).status).toBe(204);
  expect(await db.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(0);
  const ignored = await db
    .prepare(
      "SELECT json_extract(attributes, '$.reason') AS reason FROM diagnostic_events WHERE name = 'trigger.decided' AND json_extract(attributes, '$.outcome') = 'ignored' ORDER BY ingest_seq",
    )
    .all<{ reason: string }>();
  expect(ignored.results.map((row) => row.reason)).toEqual([
    "repository",
    "label",
    "actor",
    "installation",
    "issue_state",
    "pull_request",
  ]);
  const response = await send(event);
  expect(response.status).toBe(202);
  const data: {
    results: { sessionId: string; runId: string; routineId: string }[];
  } = await response.json();
  expect(data.results).toHaveLength(1);
  expect(data.results[0].routineId).toBe(routine.id);
  expect(await (await send(event)).json()).toEqual(data);
  // The redelivery reports the same Turn without starting it again.
  expect(schedule).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare(
        "SELECT count(*) AS n FROM diagnostic_links WHERE relation = 'replays'",
      )
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT count(DISTINCT t.id) AS n FROM diagnostic_traces t JOIN diagnostic_links l ON l.from_trace = t.id WHERE t.source = 'github.issue-label' AND t.delivery_id = 'one' ",
      )
      .first("n"),
  ).toBe(2);

  const stored = await db
    .prepare(
      "SELECT execution_context AS context, deadline_at - created_at AS duration FROM runs WHERE id = ?",
    )
    .bind(data.results[0].runId)
    .first<{ context: string; duration: number }>();
  expect(JSON.parse(stored!.context)).toMatchObject({
    connectionId: `codex/${owner.id}`,
    model: "test-model",
    effort: "high",
    repository: { repository: "owner/private", repositoryId: 42 },
    trigger: {
      kind: "github.issue-label",
      issueNumber: event.issue.number,
      issueContentHash: await githubIssueDigest(event.issue),
      label: "build",
    },
  });
  expect(stored!.duration).toBe(180_000);
  expect(
    await db
      .prepare(
        "SELECT body FROM session_messages WHERE session_id = ? AND seq = 1",
      )
      .bind(data.results[0].sessionId)
      .first("body"),
  ).toBe("Implement the issue identified by structured job context.");
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM issue_notifications")
      .first("n"),
  ).toBe(1);
  const url = `${env.TAILOS_PUBLIC_ORIGIN}/v1/sessions/${data.results[0].sessionId}`;
  expect((await app.request(url, undefined, env)).status).toBe(401);
  const detail = await app.request(
    url,
    { headers: { Cookie: owner.cookie } },
    env,
  );
  expect(detail.status).toBe(200);
  expect(await detail.text()).not.toContain("Private details");
});

test("a Claude Routine starts its Turn on the owner's Claude connection", async (t) => {
  const db = await createTestDb(t);
  const login = testLoginBindings(db);
  const owner = await createTestOperator(login);
  const project = await d1Projects(db).create(
    {
      name: "Project",
      repository: "owner/private",
      repositoryId: 42,
      installationId: 19,
      maxRunMinutes: 3,
    },
    owner.id,
  );
  await d1Routines(db).save(owner.id, project.project.id, {
    name: "Implement",
    enabled: true,
    engine: "claude",
    prompt: "Implement the issue identified by structured job context.",
    model: "claude-opus-5-5",
    effort: "xhigh",
    trigger: { version: 1, type: "github.issue-label", label: "build" },
    allowedActors: ["builder"],
  });
  const env = {
    ...login,
    RUNNER: { getByName: () => ({ schedule: async () => {} }) },
    TAILOS_GH_WEBHOOK_SECRET: "test-secret",
    TAILOS_GH_APP_ID: "100",
    TAILOS_GH_APP_PRIVATE_KEY: "unused",
  };
  const pending: Promise<unknown>[] = [];
  const body = JSON.stringify({
    action: "labeled",
    repository: { id: 42, full_name: "owner/private", default_branch: "main" },
    installation: { id: 19 },
    issue: { number: 3, title: "Issue", body: "Details", state: "open" },
    label: { name: "build" },
    sender: { login: "builder" },
  });
  const response = await app.request(
    "https://tailos.example/webhooks/github",
    {
      method: "POST",
      body,
      headers: {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "claude",
        "X-Hub-Signature-256":
          "sha256=" +
          createHmac("sha256", env.TAILOS_GH_WEBHOOK_SECRET)
            .update(body)
            .digest("hex"),
      },
    },
    env,
    {
      waitUntil: (work: Promise<unknown>) => void pending.push(work),
      passThroughOnException: () => {},
      props: {},
    },
  );
  // Background work ends before the test database does.
  await Promise.allSettled(pending);
  expect(response.status).toBe(202);
  const context = await db
    .prepare("SELECT execution_context FROM runs")
    .first<string>("execution_context");
  expect(JSON.parse(context!)).toMatchObject({
    engine: "claude",
    connectionId: `claude/${owner.id}`,
    model: "claude-opus-5-5",
    effort: "xhigh",
  });
});

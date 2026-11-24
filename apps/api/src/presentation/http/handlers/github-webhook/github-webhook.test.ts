import { createHmac } from "node:crypto";
import { assert, expect, test, vi } from "vitest";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import app from "@/bootstrap/http.ts";
import { createGithubWebhook } from "@/presentation/http/handlers/github-webhook/github-webhook.ts";
import {
  admitIssueMessage,
  dispatchSessionInbox,
} from "@/infrastructure/d1/session-inbox.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";
import { d1Routines } from "@/infrastructure/d1/routines.ts";
import {
  planningPrompt,
  type RoutineSettings,
} from "@/application/routines/routines.ts";
import { planningGuidance } from "@/application/routines/dispatch-issue.ts";

const planRoutine: RoutineSettings = {
  name: "Planning",
  enabled: true,
  trigger: { version: 1, type: "github.issue-comment", command: "plan" },
  allowedActors: ["allowed"],
  engine: "codex",
  prompt: planningPrompt,
};

test("runs plan comments as the plan Routine's Session and rejects ineligible comments", async (t) => {
  const db = await createTestDb(t);
  const schedule = vi.fn(async () => {});
  const background: Promise<unknown>[] = [];
  const env = {
    ...testLoginBindings(db),
    RUNNER: { getByName: () => ({ schedule }) },
    TAILOS_GH_WEBHOOK_SECRET: "secret",
    TAILOS_GH_APP_ID: "100",
    TAILOS_GH_APP_PRIVATE_KEY: "unused",
  };
  const owner = await createTestOperator(env);
  const project = await d1Projects(db).create(
    {
      name: "Tailos",
      repository: "owner/repo",
      repositoryId: 42,
      installationId: 19,
      maxRunMinutes: 30,
    },
    owner.id,
  );
  await d1Routines(db).save(owner.id, project.project.id, planRoutine);
  const event = {
    action: "created",
    repository: { id: 42, full_name: "owner/repo", default_branch: "main" },
    installation: { id: 19 },
    issue: {
      number: 8,
      state: "open",
      title: "Investigate",
      body: "Use the issue alone",
    },
    sender: { login: "allowed", type: "User" },
    comment: {
      id: 100,
      user: { login: "allowed", type: "User" },
      body: "@tailos plan",
      html_url: "https://github.com/owner/repo/issues/8#issuecomment-100",
    },
  };
  const send = async (
    payload: object,
    delivery = crypto.randomUUID(),
    secret = "secret",
    waitForBackground = true,
  ) => {
    const body = JSON.stringify(payload);
    const response = await app.request(
      "https://tailos.example/webhooks/github",
      {
        method: "POST",
        body,
        headers: {
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": delivery,
          "X-Hub-Signature-256":
            "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
        },
      },
      env,
      {
        waitUntil: (task) => {
          background.push(task);
        },
        passThroughOnException: () => {},
        props: {},
      },
    );
    if (waitForBackground) await Promise.all(background);
    return response;
  };
  expect((await send(event, undefined, "invalid")).status).toBe(401);
  for (const body of [
    "No command",
    "> @tailos plan",
    "```\n@tailos plan\n```",
    "    @tailos plan",
    "Example\n@tailos plan",
    "@tailos",
    "@tailos-other plan",
  ]) {
    expect(
      (await send({ ...event, comment: { ...event.comment, body } })).status,
    ).toBe(204);
    expect(
      await db
        .prepare(
          "SELECT json_extract(attributes, '$.reason') AS reason FROM diagnostic_events ORDER BY ingest_seq DESC LIMIT 1",
        )
        .first("reason"),
    ).toBe("command");
  }
  for (const change of [
    { action: "edited" },
    { action: "deleted" },
    { issue: { ...event.issue, state: "closed" } },
    { issue: { ...event.issue, pull_request: { url: "x" } } },
    { installation: { id: 20 } },
    { repository: { ...event.repository, id: 43 } },
    { sender: { login: "unknown", type: "User" } },
    { sender: { login: "allowed", type: "Bot" } },
    { comment: { ...event.comment, user: { login: "allowed", type: "Bot" } } },
  ])
    expect((await send({ ...event, ...change })).status).toBe(204);
  expect(schedule).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT json_extract(attributes, '$.reason') AS reason FROM diagnostic_events ORDER BY ingest_seq DESC LIMIT 1",
      )
      .first("reason"),
  ).toBe("actor");
  expect(
    await db.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(0);
  // Nothing to continue yet: the commenter hears how to start.
  const guidance = await send({
    ...event,
    comment: { ...event.comment, body: "@tailos help" },
  });
  expect(guidance.status).toBe(202);
  expect(schedule).not.toHaveBeenCalled();
  expect(
    await db.prepare("SELECT body FROM issue_guidance").first("body"),
  ).toBe(planningGuidance);
  expect(
    await db.prepare("SELECT count(*) AS n FROM sessions").first("n"),
  ).toBe(0);
  let rejectScheduling: (error: Error) => void = () => {};
  const scheduling = new Promise<void>((_resolve, reject) => {
    rejectScheduling = reject;
  });
  schedule.mockImplementationOnce(() => scheduling);
  const first = await send(
    {
      ...event,
      comment: { ...event.comment, id: 101 },
    },
    undefined,
    undefined,
    false,
  );
  expect(first.status).toBe(202);
  // The response and durable receipt must be available while scheduling is blocked.
  expect(
    await db.prepare("SELECT count(*) AS n FROM session_inbox").first("n"),
  ).toBe(1);
  await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
  rejectScheduling(new Error("Alarm unavailable"));
  await Promise.all(background);
  expect(
    await db
      .prepare(
        "SELECT json_extract(attributes, '$.reason') AS reason FROM diagnostic_events ORDER BY ingest_seq DESC LIMIT 1",
      )
      .first("reason"),
  ).toBe("schedule");
  const receipt: {
    results: { sessionId: string; runId?: string; disposition: string }[];
  } = await first.json();
  const [started] = receipt.results;
  assert(started?.runId);
  expect(started.disposition).toBe("started");
  // The comment is the message; the Routine's prompt says what to do.
  expect(
    JSON.parse(
      (await db
        .prepare("SELECT execution_context FROM runs")
        .first<string>("execution_context"))!,
    ),
  ).toMatchObject({
    mode: "plan",
    instructions: planningPrompt,
    trigger: { kind: "github.issue-comment", issueNumber: 8 },
  });
  expect(
    await db
      .prepare("SELECT body FROM session_messages WHERE seq = 1")
      .first("body"),
  ).toBe("@tailos plan");
  // A comment while the Turn runs waits in the same Session.
  const second = await send({
    ...event,
    comment: { ...event.comment, id: 102, body: "@tailos choose option B" },
  });
  const secondReceipt: typeof receipt = await second.json();
  expect(secondReceipt.results).toEqual([
    {
      routineId: expect.any(String),
      sessionId: started.sessionId,
      disposition: "queued",
    },
  ]);
  expect(schedule).toHaveBeenCalledTimes(1);
  await db
    .prepare(
      "UPDATE runs SET status = 'succeeded', finished_at = 1 WHERE id = ?",
    )
    .bind(started.runId)
    .run();
  const [next] = await dispatchSessionInbox(db);
  expect(
    await db
      .prepare(
        "SELECT m.body FROM runs r JOIN session_messages m ON m.id = r.start_message_id WHERE r.id = ?",
      )
      .bind(next)
      .first("body"),
  ).toBe("@tailos choose option B");
  const receipt2 = { sessionId: started.sessionId };
  expect(
    (
      await app.request(
        `https://api.tailos.example/v1/sessions/${receipt2.sessionId}`,
        undefined,
        env,
      )
    ).status,
  ).toBe(401);
});

test.for([false, true])(
  "shows the plan Turn on the issue without waiting for scheduling (schedule fails: %s)",
  async (scheduleFails, t) => {
    const DB = await createTestDb(t);
    const owner = "00000000-0000-4000-8000-000000000001";
    const recordDecision = vi.fn(async () => {});
    const notify = vi.fn(async () => {
      expect(
        await DB.prepare("SELECT count(*) AS n FROM issue_notifications").first(
          "n",
        ),
      ).toBe(1);
    });
    const background: Promise<unknown>[] = [];
    const project = await d1Projects(DB).create(
      {
        name: "Tailos",
        repository: "owner/repo",
        repositoryId: 42,
        installationId: 19,
        maxRunMinutes: 30,
      },
      owner,
    );
    await d1Routines(DB).save(owner, project.project.id, planRoutine);
    const schedule = vi.fn(async () => {
      if (scheduleFails) throw new Error("Alarm unavailable");
    });
    const webhook = createGithubWebhook(
      () => schedule,
      (env) => (input) => admitIssueMessage(env.DB, input),
      async () => owner,
      async () => true,
      (env) => d1Projects(env.DB).list(),
      recordDecision,
      notify,
      (env, id) => d1Routines(env.DB).candidates(id),
    );
    const response = await webhook.request(
      "/",
      {
        method: "POST",
        headers: {
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "planning-notification-order",
        },
        body: JSON.stringify({
          action: "created",
          repository: {
            id: 42,
            full_name: "owner/repo",
            default_branch: "main",
          },
          installation: { id: 19 },
          issue: { number: 8, state: "open", title: "Plan", body: "Details" },
          sender: { login: "allowed", type: "User" },
          comment: {
            id: 100,
            user: { login: "allowed", type: "User" },
            body: "@tailos plan",
            html_url: "https://github.com/owner/repo/issues/8#issuecomment-100",
          },
        }),
      },
      {
        DB,
        TAILOS_GH_WEBHOOK_SECRET: "secret",
        TAILOS_GH_APP_ID: "100",
        TAILOS_GH_APP_PRIVATE_KEY: "unused",
      },
      {
        waitUntil: (task) => {
          background.push(task);
        },
        passThroughOnException: () => {},
        props: {},
      },
    );
    expect(response.status).toBe(202);
    await Promise.all(background);
    expect(schedule).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    if (scheduleFails) {
      expect(recordDecision).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: "schedule", outcome: "unknown" }),
      );
    } else expect(recordDecision).not.toHaveBeenCalled();
  },
);

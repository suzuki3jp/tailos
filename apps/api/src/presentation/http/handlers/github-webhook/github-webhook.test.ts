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
  acceptPlanningInput,
  dispatchPlanningInputs,
} from "@/infrastructure/d1/planning.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";

test("accepts explicit new planning comments without labels and rejects ineligible comments", async (t) => {
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
  await d1Projects(db).create(
    {
      name: "Tailos",
      repository: "owner/repo",
      repositoryId: 42,
      installationId: 19,
      allowedActors: ["allowed"],
      maxRunMinutes: 30,
    },
    "setup",
  );
  await createTestOperator(env);
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
  const guidance = await send({
    ...event,
    comment: { ...event.comment, body: "@tailos help" },
  });
  expect(guidance.status).toBe(202);
  expect(schedule).not.toHaveBeenCalled();
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
    await db.prepare("SELECT count(*) AS n FROM planning_inbox").first("n"),
  ).toBe(2);
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
  const receipt = await first.json();
  assert(
    receipt &&
      typeof receipt === "object" &&
      "sessionId" in receipt &&
      typeof receipt.sessionId === "string",
  );
  const second = await send({
    ...event,
    comment: { ...event.comment, id: 102, body: "@tailos choose option B" },
  });
  const secondReceipt = await second.json();
  assert(
    secondReceipt &&
      typeof secondReceipt === "object" &&
      "sessionId" in secondReceipt,
  );
  expect(secondReceipt.sessionId).toBe(receipt.sessionId);
  expect(schedule).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare(
        "SELECT count(*) AS n FROM planning_inbox WHERE state = 'pending'",
      )
      .first("n"),
  ).toBe(1);
  expect(
    JSON.parse(
      (await db
        .prepare("SELECT execution_context FROM runs")
        .first<string>("execution_context"))!,
    ).mode,
  ).toBe("plan");
  expect(
    (
      await app.request(
        `https://api.tailos.example/v1/sessions/${receipt.sessionId}`,
        undefined,
        env,
      )
    ).status,
  ).toBe(401);
});

test.for([false, true])(
  "delivers planning status after dispatch without blocking acknowledgement (schedule fails: %s)",
  async (scheduleFails, t) => {
    const DB = await createTestDb(t);
    let releaseDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const background: Promise<unknown>[] = [];
    const recordDecision = vi.fn(async () => {});
    const notify = vi.fn(async () => {
      expect(
        await DB.prepare("SELECT count(*) AS n FROM issue_notifications").first(
          "n",
        ),
      ).toBe(1);
    });
    await d1Projects(DB).create(
      {
        name: "Tailos",
        repository: "owner/repo",
        repositoryId: 42,
        installationId: 19,
        allowedActors: ["allowed"],
        maxRunMinutes: 30,
      },
      "setup",
    );
    const webhook = createGithubWebhook(
      () => undefined,
      () => async () => {
        throw new Error("Unexpected label admission");
      },
      async () => "operator",
      async () => true,
      (env) => d1Projects(env.DB).list(),
      recordDecision,
      notify,
      (env, input) => acceptPlanningInput(env.DB, input),
      async (env) => {
        await dispatchGate;
        expect(await dispatchPlanningInputs(env.DB)).toHaveLength(1);
        if (scheduleFails) throw new Error("Alarm unavailable");
      },
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
    expect(await response.json()).toEqual({
      sessionId: expect.any(String),
      inputId: expect.any(Number),
    });
    expect(notify).not.toHaveBeenCalled();
    expect(await DB.prepare("SELECT count(*) AS n FROM runs").first("n")).toBe(
      0,
    );
    releaseDispatch();
    await Promise.all(background);
    expect(notify).toHaveBeenCalledOnce();
    if (scheduleFails) {
      expect(recordDecision).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: "schedule", outcome: "unknown" }),
      );
    } else expect(recordDecision).not.toHaveBeenCalled();
  },
);

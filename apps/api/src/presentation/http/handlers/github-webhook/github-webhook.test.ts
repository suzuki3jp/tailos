import { createHmac } from "node:crypto";
import { assert, expect, test, vi } from "vitest";
import * as v from "valibot";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import app from "@/bootstrap/http.ts";
import { githubIssueDigest } from "@tailos/core/runner";
import { createGithubWebhook } from "@/presentation/http/handlers/github-webhook/github-webhook.ts";
import {
  acceptPlanningInput,
  dispatchPlanningInputs,
} from "@/infrastructure/d1/planning.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";

test.for([undefined, false, true] as const)(
  "accepts signed issue events with project network setting %s and rejects unauthorized actors",
  async (agentNetworkAccess, t) => {
    const db = await createTestDb(t);
    const schedule = vi.fn(async (_id: string) => {
      throw new Error("Alarm unavailable");
    });
    const event = {
      action: "labeled",
      agentNetworkAccess: true,
      repository: {
        id: 42,
        full_name: "owner/private",
        default_branch: "main",
        private: true,
      },
      installation: { id: 19 },
      issue: {
        number: 8,
        state: "open",
        title: "Fix an issue",
        body: "Private issue details",
      },
      label: { name: "tailos:run" },
      sender: { login: "allowed-user" },
    };
    const env = {
      ...testLoginBindings(db),
      RUNNER: { getByName: () => ({ schedule }) },
      TAILOS_GH_WEBHOOK_SECRET: "test-secret",
      TAILOS_GH_APP_ID: "100",
      TAILOS_GH_APP_PRIVATE_KEY: "unused-until-run",
    };
    await d1Projects(db).create(
      {
        repository: "owner/private",
        repositoryId: 42,
        installationId: 19,
        triggerLabel: "tailos:run",
        allowedActors: ["allowed-user"],
        agentNetworkAccess: agentNetworkAccess ?? false,
        maxRunMinutes: 30,
      },
      "setup",
    );
    const send = (
      payload: object,
      secret = env.TAILOS_GH_WEBHOOK_SECRET,
      delivery = "test-delivery",
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
              "sha256=" +
              createHmac("sha256", secret).update(body).digest("hex"),
          },
        },
        env,
        { waitUntil: () => {}, passThroughOnException: () => {}, props: {} },
      );
    };

    expect((await send(event, "wrong-secret")).status).toBe(401);
    expect(
      (await send({ ...event, sender: { login: "unknown" } })).status,
    ).toBe(204);
    expect((await send({ ...event, installation: { id: 20 } })).status).toBe(
      204,
    );
    expect(
      await db.prepare("SELECT count(*) AS count FROM runs").first("count"),
    ).toBe(0);

    const uninitialized = await send(event);
    expect(uninitialized.status).toBe(503);
    expect(
      await db.prepare("SELECT count(*) AS count FROM runs").first("count"),
    ).toBe(0);

    const operator = await createTestOperator(env);
    await db
      .prepare(`CREATE TRIGGER reject_detail_decisions BEFORE INSERT ON diagnostic_events
      WHEN NEW.name = 'trigger.decided' AND json_extract(NEW.attributes, '$.reason') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'test diagnostics unavailable'); END`)
      .run();
    expect(
      (await send({ ...event, sender: { login: "unknown" } })).status,
    ).toBe(204);
    expect(schedule).not.toHaveBeenCalled();
    const accepted = await send(event);
    expect(accepted.status).toBe(202);
    const data = await accepted.json();
    assert(
      data &&
        typeof data === "object" &&
        "sessionId" in data &&
        "runId" in data,
    );
    expect(await (await send(event)).json()).toStrictEqual(data);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledWith(data.runId);
    expect(
      await db
        .prepare("SELECT owner_id FROM sessions WHERE id = ?")
        .bind(data.sessionId)
        .first("owner_id"),
    ).toBe(operator.id);
    const run = await db
      .prepare("SELECT execution_context FROM runs WHERE id = ?")
      .bind(data.runId)
      .first<string>("execution_context");
    expect(JSON.parse(run ?? "null").connectionId).toBe(`codex/${operator.id}`);
    expect(JSON.parse(run ?? "null").repository.issueContentHash).toBe(
      await githubIssueDigest(event.issue),
    );
    expect(JSON.parse(run ?? "null").repository.agentNetworkAccess).toBe(
      agentNetworkAccess ?? false,
    );
    expect(
      await db.prepare("SELECT count(*) AS count FROM runs").first("count"),
    ).toBe(1);
    const path = `https://api.tailos.example/api/sessions/${data.sessionId}`;
    expect((await app.request(path, undefined, env)).status).toBe(401);
    const view = await app.request(
      path,
      {
        headers: { Cookie: operator.cookie },
      },
      env,
    );
    expect(view.status).toBe(200);
    const session = await view.text();
    expect(session).toContain("structured job context");
    expect(session).not.toContain("Private issue details");
    const detail = v.parse(
      v.object({
        session: v.object({ title: v.string() }),
        messages: v.array(v.object({ body: v.string() })),
      }),
      JSON.parse(session),
    );
    expect(detail.session.title).toBe("Fix an issue");
    expect(JSON.stringify(detail.messages)).not.toContain("Fix an issue");
    await db
      .prepare(
        "INSERT INTO sessions (id, owner_id, created_at) VALUES (?, ?, ?)",
      )
      .bind("other-session", crypto.randomUUID(), Date.now())
      .run();
    const another = await app.request(
      "https://api.tailos.example/api/sessions/other-session",
      { headers: { Cookie: operator.cookie } },
      env,
    );
    expect(another.status).toBe(404);
    const store = d1Projects(db);
    const [configured] = await store.list();
    const oldDeadline = await db
      .prepare("SELECT deadline_at FROM runs WHERE id = ?")
      .bind(data.runId)
      .first("deadline_at");
    await store.update(
      configured.project.id,
      1,
      {
        repository: configured.project.repository,
        repositoryId: configured.project.repositoryId,
        installationId: configured.project.installationId,
        triggerLabel: configured.project.triggerLabel,
        allowedActors: ["next-user"],
        agentNetworkAccess: !(agentNetworkAccess ?? false),
        maxRunMinutes: 1,
      },
      operator.id,
    );
    expect((await send(event)).status).toBe(204);
    expect(
      await db
        .prepare("SELECT execution_context FROM runs WHERE id = ?")
        .bind(data.runId)
        .first("execution_context"),
    ).toBe(run);
    expect(
      await db
        .prepare("SELECT deadline_at FROM runs WHERE id = ?")
        .bind(data.runId)
        .first("deadline_at"),
    ).toBe(oldDeadline);
    await db
      .prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?")
      .bind(data.runId)
      .run();
    const next = await send(
      { ...event, sender: { login: "next-user" } },
      env.TAILOS_GH_WEBHOOK_SECRET,
      "next-delivery",
    );
    expect(next.status).toBe(202);
    const [nextRun] = await db
      .prepare(
        "SELECT execution_context, deadline_at, created_at FROM runs WHERE id != ?",
      )
      .bind(data.runId)
      .all<{
        execution_context: string;
        deadline_at: number;
        created_at: number;
      }>()
      .then((r) => r.results);
    expect(
      JSON.parse(nextRun.execution_context).repository.agentNetworkAccess,
    ).toBe(!(agentNetworkAccess ?? false));
    expect(nextRun.deadline_at - nextRun.created_at).toBe(60_000);
    await store.remove(configured.project.id, 2, operator.id);
    expect(
      (
        await send(
          { ...event, sender: { login: "next-user" } },
          env.TAILOS_GH_WEBHOOK_SECRET,
          "after-delete",
        )
      ).status,
    ).toBe(204);
    expect(
      (await app.request(path, { headers: { Cookie: operator.cookie } }, env))
        .status,
    ).toBe(200);
  },
);

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
      repository: "owner/repo",
      repositoryId: 42,
      installationId: 19,
      triggerLabel: "tailos:run",
      allowedActors: ["allowed"],
      agentNetworkAccess: false,
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
        `https://api.tailos.example/api/sessions/${receipt.sessionId}`,
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
        repository: "owner/repo",
        repositoryId: 42,
        installationId: 19,
        triggerLabel: "tailos:run",
        allowedActors: ["allowed"],
        agentNetworkAccess: false,
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

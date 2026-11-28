import { expect, test } from "vitest";
import * as v from "valibot";
import app from "@/bootstrap/http.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";

const pageSchema = v.object({
  items: v.array(v.looseObject({ id: v.string() })),
  nextCursor: v.nullable(v.string()),
});

test("session listing authenticates the owner and pages tied timestamps without leaking other accounts", async (t) => {
  const db = await createTestDb(t);
  const env = testLoginBindings(db);
  const operator = await createTestOperator(env);
  const trigger = JSON.stringify({
    kind: "github.issue",
    repository: "owner/repo",
    number: 3,
  });
  for (const [id, owner, time, project] of [
    ["z", operator.id, 20, null],
    ["b", operator.id, 10, "deleted-project"],
    ["a", operator.id, 10, null],
    ["outside", "other-owner", 99, null],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO sessions (id, owner_id, title, trigger_metadata, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, owner, `Title ${id}`, trigger, project, time)
      .run();
  }
  const send = (query = "", cookie = operator.cookie) =>
    app.request(
      `${env.TAILOS_PUBLIC_ORIGIN}/v1/sessions${query}`,
      { headers: { Cookie: cookie } },
      env,
    );
  expect((await send("", "")).status).toBe(401);
  for (const query of [
    "?limit=0",
    "?limit=101",
    "?limit=1.5",
    "?limit=",
    "?limit=2&limit=3",
    "?cursor=",
    "?cursor=bad!",
    "?cursor=e30",
    "?cursor=e30&cursor=e30",
  ]) {
    expect((await send(query)).status, query).toBe(400);
  }
  const first = await send("?limit=2&ownerId=other-owner");
  expect(first.headers.get("Cache-Control")).toBe("private, no-store");
  const page = v.parse(pageSchema, await first.json());
  expect(page.items.map((item: { id: string }) => item.id)).toEqual(["z", "b"]);
  expect(page.items[1]).toMatchObject({
    title: "Title b",
    trigger: {
      kind: "github.issue",
      repository: "owner/repo",
      number: 3,
      url: "https://github.com/owner/repo/issues/3",
    },
    project: { id: "deleted-project" },
    createdAt: 10,
    updatedAt: 10,
    latestRun: null,
  });
  const last = v.parse(
    pageSchema,
    await (await send(`?limit=2&cursor=${page.nextCursor}`)).json(),
  );
  expect(last.items.map((item: { id: string }) => item.id)).toEqual(["a"]);
  expect(last.nextCursor).toBeNull();
  await db
    .prepare(
      "INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at) VALUES ('m', 'a', 1, 'user', 'private body', 30)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO runs (id, session_id, start_message_id, status, execution_context, deadline_at, created_at, error_code) VALUES ('failed', 'a', 'm', 'failed', '{}', 99, 30, 'agent_failed')",
    )
    .run();
  const refreshed = v.parse(pageSchema, await (await send()).json());
  expect(refreshed.items[0]).toMatchObject({
    id: "a",
    latestRun: { id: "failed", status: "failed", errorCode: "agent_failed" },
  });
  expect(JSON.stringify(refreshed)).not.toContain("private body");
});

test("scopes project session pages by owner and project, including histories of deleted projects", async (t) => {
  const db = await createTestDb(t);
  const env = testLoginBindings(db);
  const operator = await createTestOperator(env);
  const projectId = "deleted/project";
  const time = Date.now();
  await db.batch(
    [
      ["first", operator.id, projectId, time + 1],
      ["second", operator.id, projectId, time],
      ["standalone", operator.id, null, time + 10],
      ["foreign", "other-owner", projectId, time + 10],
      ["wrong-project", operator.id, "another", time + 10],
    ].map(([id, owner, project, time]) =>
      db
        .prepare(
          "INSERT INTO sessions (id, owner_id, project_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id, owner, project, time),
    ),
  );
  await db.batch([
    db
      .prepare(
        "INSERT INTO session_messages (id, session_id, seq, author_kind, body, created_at) VALUES ('prompt', 'first', 1, 'user', 'Prompt', ?)",
      )
      .bind(time),
    db
      .prepare(
        "INSERT INTO runs (id, session_id, start_message_id, status, execution_context, deadline_at, created_at) VALUES ('run', 'first', 'prompt', 'succeeded', '{}', ?, ?)",
      )
      .bind(time, time),
    db
      .prepare(
        "INSERT INTO diagnostic_traces (id, owner_id, session_id, run_id, source, created_at, expires_at) VALUES ('run/run', ?, 'first', 'run', 'run', ?, ?)",
      )
      .bind(operator.id, time, time + 60_000),
    db
      .prepare(
        "INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, occurred_at, received_at, name, attributes) VALUES (?, 'run/run', ?, 'runner', ?, ?, 'span.finished', ?)",
      )
      .bind(
        "command",
        "command",
        time,
        time,
        JSON.stringify({ operation: "command", durationMs: 10_000 }),
      ),
    db
      .prepare(
        "INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, occurred_at, received_at, name, attributes) VALUES (?, 'run/run', ?, 'runner', ?, ?, 'span.finished', ?)",
      )
      .bind(
        "agent",
        "agent",
        time,
        time,
        JSON.stringify({ operation: "agent", durationMs: 752_000 }),
      ),
  ]);
  const send = (suffix = "", project = projectId, cookie = operator.cookie) =>
    app.request(
      `${env.TAILOS_PUBLIC_ORIGIN}/v1/projects/${encodeURIComponent(project)}/sessions${suffix}`,
      { headers: { Cookie: cookie } },
      env,
    );
  expect((await send("/first", projectId, "")).status).toBe(401);
  expect((await send("/first", "another")).status).toBe(404);
  expect((await send("/foreign")).status).toBe(404);
  expect((await send("/standalone")).status).toBe(404);
  expect((await send("?cursor=x&cursor=y")).status).toBe(400);

  const first = await send("?limit=1");
  expect(first.status).toBe(200);
  const page = v.parse(pageSchema, await first.json());
  expect(page.items.map((item) => item.id)).toEqual(["first"]);
  const next = await send(`?limit=1&cursor=${page.nextCursor}`);
  expect(
    v.parse(pageSchema, await next.json()).items.map((item) => item.id),
  ).toEqual(["second"]);

  const detail = await send("/first");
  expect(detail.headers.get("Cache-Control")).toBe("private, no-store");
  const payload = await detail.json();
  expect(payload).toMatchObject({
    projectName: null,
    detail: {
      messages: [{ body: "Prompt" }],
      runs: [
        {
          id: "run",
          startMessageId: "prompt",
          engine: null,
          agentDurationMs: 752_000,
        },
      ],
    },
  });
  expect(JSON.stringify(payload)).not.toContain('"jobContext"');

  const contentHash = "a".repeat(64);
  await db
    .prepare("UPDATE runs SET execution_context = ? WHERE id = 'run'")
    .bind(
      JSON.stringify({
        version: 1,
        engine: "codex",
        connectionId: "codex/10000000-0000-0000-0000-000000000001",
        repository: {
          repository: "owner/repo",
          repositoryId: 1,
          installationId: 2,
          defaultBranch: "main",
        },
        trigger: {
          kind: "github.issue-label",
          label: "start",
          issueNumber: 166,
          issueContentHash: contentHash,
        },
      }),
    )
    .run();
  const triggered = await (await send("/first")).json();
  expect(triggered).toMatchObject({
    detail: {
      messages: [
        { jobContext: { github: { kind: "issue", number: 166, contentHash } } },
      ],
    },
  });
  expect(JSON.stringify(triggered)).not.toContain('"executionContext"');
});

test("lists only the Sessions a Routine keeps for the owner", async (t) => {
  const db = await createTestDb(t);
  const env = testLoginBindings(db);
  const operator = await createTestOperator(env);
  const projectId = crypto.randomUUID();
  const routineId = crypto.randomUUID();
  const otherRoutineId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO projects (id, name, owner_id, repository_id, config, created_at, updated_at, updated_by) VALUES (?, 'Project', ?, 42, '{}', 1, 1, ?)",
      )
      .bind(projectId, operator.id, operator.id),
    ...[routineId, otherRoutineId].map((id) =>
      db
        .prepare(
          "INSERT INTO routines (id, project_id, config, created_at, updated_at, updated_by) VALUES (?, ?, '{}', 1, 1, ?)",
        )
        .bind(id, projectId, operator.id),
    ),
    ...(
      [
        ["older", operator.id, 10],
        ["newer", operator.id, 20],
        ["other-routine", operator.id, 30],
        ["unlinked", operator.id, 40],
        ["foreign", "other-owner", 50],
      ] as const
    ).map(([id, owner, time]) =>
      db
        .prepare(
          "INSERT INTO sessions (id, owner_id, project_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id, owner, projectId, time),
    ),
    ...(
      [
        ["older", operator.id, routineId, 1],
        ["newer", operator.id, routineId, 2],
        ["other-routine", operator.id, otherRoutineId, 3],
        ["foreign", "other-owner", routineId, 4],
      ] as const
    ).map(([session, owner, routine, issue]) =>
      db
        .prepare(
          "INSERT INTO routine_sessions (owner_id, project_id, routine_id, repository_id, issue_number, session_id, last_message_at) VALUES (?, ?, ?, 42, ?, ?, 1)",
        )
        .bind(owner, projectId, routine, issue, session),
    ),
  ]);
  const send = (query: string) =>
    app.request(
      `${env.TAILOS_PUBLIC_ORIGIN}/v1/projects/${projectId}/sessions${query}`,
      { headers: { Cookie: operator.cookie } },
      env,
    );
  for (const query of [
    "?routineId=",
    "?routineId=not-a-uuid",
    `?routineId=${routineId}&routineId=${routineId}`,
  ])
    expect((await send(query)).status, query).toBe(400);
  const page = v.parse(
    pageSchema,
    await (await send(`?limit=10&routineId=${routineId}`)).json(),
  );
  expect(page.items.map((item) => item.id)).toEqual(["newer", "older"]);
  expect(page.nextCursor).toBeNull();
});

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
      `${env.TAILOS_PUBLIC_ORIGIN}/api/sessions${query}`,
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

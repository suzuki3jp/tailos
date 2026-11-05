import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text().primaryKey().notNull(),
  ownerId: text("owner_id").notNull(),
  projectId: text("project_id"),
  target: text(),
  createdAt: integer("created_at").notNull(),
});

export const sessionMessages = sqliteTable(
  "session_messages",
  {
    id: text().primaryKey().notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    seq: integer().notNull(),
    authorKind: text("author_kind", {
      enum: ["user", "automation", "agent"],
    }).notNull(),
    body: text().notNull(),
    runId: text("run_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    unique("message_session_sequence").on(t.sessionId, t.seq),
    unique("message_session_id").on(t.sessionId, t.id),
    foreignKey({
      name: "message_run_in_session",
      columns: [t.sessionId, t.runId],
      foreignColumns: [runs.sessionId, runs.id],
    }),
    check(
      "message_author",
      sql`${t.authorKind} in ('user', 'automation', 'agent')`,
    ),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text().primaryKey().notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    startMessageId: text("start_message_id").notNull().unique(),
    status: text({
      enum: ["queued", "running", "succeeded", "failed"],
    }).notNull(),
    concurrencyKey: text("concurrency_key"),
    executionContext: text("execution_context").notNull(),
    stepState: text("step_state"),
    result: text(),
    errorCode: text("error_code"),
    deadlineAt: integer("deadline_at").notNull(),
    nextActionAt: integer("next_action_at"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    unique("run_session_id").on(t.sessionId, t.id),
    foreignKey({
      name: "run_start_message_in_session",
      columns: [t.sessionId, t.startMessageId],
      foreignColumns: [sessionMessages.sessionId, sessionMessages.id],
    }),
    check(
      "run_status",
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed')`,
    ),
    uniqueIndex("one_active_run_per_session")
      .on(t.sessionId)
      .where(sql`${t.status} in ('queued', 'running')`),
    uniqueIndex("one_active_run_per_target")
      .on(t.concurrencyKey)
      .where(
        sql`${t.status} in ('queued', 'running') and ${t.concurrencyKey} is not null`,
      ),
    index("run_next_action").on(t.nextActionAt),
  ],
);

export const triggerEvents = sqliteTable(
  "trigger_events",
  {
    id: text().primaryKey().notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    source: text().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    disposition: text({ enum: ["started", "coalesced"] }).notNull(),
    receivedAt: integer("received_at").notNull(),
  },
  (t) => [
    unique("unique_trigger_delivery").on(t.source, t.idempotencyKey),
    uniqueIndex("one_start_event_per_run")
      .on(t.runId)
      .where(sql`${t.disposition} = 'started'`),
    check(
      "event_disposition",
      sql`${t.disposition} in ('started', 'coalesced')`,
    ),
  ],
);

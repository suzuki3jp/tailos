import { sql } from "drizzle-orm";
import { runStatuses } from "@tailos/core/run-status";
import { activeRunStatusSql, runStatusSql } from "./run-status.ts";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull().default(""),
    ownerId: text("owner_id"),
    repositoryId: integer("repository_id").notNull(),
    config: text().notNull(),
    legacyId: text("legacy_id").unique(),
    revision: integer().notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("project_owner_name")
      .on(t.ownerId, t.name, t.id)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex("project_active_repository")
      .on(t.repositoryId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const projectChanges = sqliteTable("project_changes", {
  id: integer().primaryKey({ autoIncrement: true }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  operation: text({ enum: ["create", "update", "delete", "import"] }).notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: integer("created_at").notNull(),
  before: text("before_config"),
  after: text("after_config"),
});

export const projectImports = sqliteTable("project_imports", {
  id: text().primaryKey().notNull(),
  changeId: text("change_id").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const routines = sqliteTable(
  "routines",
  {
    id: text().primaryKey().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    config: text().notNull(),
    revision: integer().notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("routine_project").on(t.projectId, t.deletedAt, t.id)],
);
export const routineChanges = sqliteTable("routine_changes", {
  id: integer().primaryKey({ autoIncrement: true }),
  routineId: text("routine_id")
    .notNull()
    .references(() => routines.id),
  actorId: text("actor_id").notNull(),
  createdAt: integer("created_at").notNull(),
  before: text("before_config"),
  after: text("after_config"),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    projectId: text("project_id"),
    target: text(),
    title: text().notNull().default("新しい会話"),
    titleGenerated: integer("title_generated", { mode: "boolean" })
      .notNull()
      .default(false),
    trigger: text("trigger_metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull().default(0),
  },
  (t) => [
    index("session_owner_created").on(t.ownerId, t.createdAt, t.id),
    index("session_owner_updated").on(
      t.ownerId,
      sql`${t.updatedAt} DESC`,
      sql`${t.id} DESC`,
    ),
  ],
);

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

export const sessionActivityItems = sqliteTable(
  "session_activity_items",
  {
    id: text().primaryKey().notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    runId: text("run_id").notNull(),
    kind: text().notNull(),
    label: text(),
    text: text(),
    status: text().notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    durationMs: integer("duration_ms"),
    exitCode: integer("exit_code"),
    revision: integer().notNull(),
    firstCursor: integer("first_cursor").notNull(),
    inputArtifact: text("input_artifact"),
    inputEvent: text("input_event"),
    outputArtifact: text("output_artifact"),
    outputEvent: text("output_event"),
    bodyExpiresAt: integer("body_expires_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("session_activity_item_page").on(t.sessionId, t.firstCursor)],
);

export const sessionActivityEvents = sqliteTable(
  "session_activity_events",
  {
    cursor: integer().primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull().unique(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    runId: text("run_id").notNull(),
    itemId: text("item_id"),
    kind: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("session_activity_event_page").on(t.sessionId, t.cursor)],
);

export const sessionActivityNotifications = sqliteTable(
  "session_activity_notifications",
  {
    sessionId: text("session_id")
      .primaryKey()
      .notNull()
      .references(() => sessions.id),
    version: integer().notNull(),
    deliveredVersion: integer("delivered_version").notNull(),
  },
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
      enum: runStatuses,
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
    check("run_status", sql`${t.status} in ${sql.raw(runStatusSql)}`),
    uniqueIndex("one_active_run_per_session")
      .on(t.sessionId)
      .where(sql`${t.status} in ${sql.raw(activeRunStatusSql)}`),
    uniqueIndex("one_active_run_per_target")
      .on(t.concurrencyKey)
      .where(
        sql`${t.status} in ${sql.raw(activeRunStatusSql)} and ${t.concurrencyKey} is not null`,
      ),
    index("run_next_action")
      .on(t.nextActionAt, t.id)
      .where(sql`${t.status} in ${sql.raw(activeRunStatusSql)}`),
    index("run_session_created").on(t.sessionId, t.createdAt, t.id),
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
    routineId: text("routine_id").references(() => routines.id),
    routineRevision: integer("routine_revision"),
    deliveryId: text("delivery_id"),
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

export const diagnosticTraces = sqliteTable(
  "diagnostic_traces",
  {
    id: text().primaryKey().notNull(),
    ownerId: text("owner_id"),
    sessionId: text("session_id"),
    runId: text("run_id").unique(),
    source: text().notNull(),
    deliveryId: text("delivery_id"),
    requestId: text("request_id"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    captureState: text("capture_state").notNull().default("unknown"),
    producerId: text("producer_id"),
    lastSeq: integer("last_seq"),
    dropped: integer().notNull().default(0),
    bodyBytes: integer("body_bytes").notNull().default(0),
  },
  (t) => [
    index("diagnostic_owner_time").on(t.ownerId, t.createdAt),
    index("diagnostic_delivery").on(t.source, t.deliveryId),
    index("diagnostic_expiry").on(t.expiresAt),
  ],
);

export const diagnosticEvents = sqliteTable(
  "diagnostic_events",
  {
    ingestSeq: integer("ingest_seq").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull().unique(),
    traceId: text("trace_id")
      .notNull()
      .references(() => diagnosticTraces.id, { onDelete: "cascade" }),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    producerId: text("producer_id").notNull(),
    producerSeq: integer("producer_seq"),
    requestId: text("request_id"),
    occurredAt: integer("occurred_at").notNull(),
    receivedAt: integer("received_at").notNull(),
    name: text().notNull(),
    attributes: text().notNull(),
    fingerprint: text().notNull().default(""),
    artifactId: text("artifact_id"),
  },
  (t) => [
    unique("diagnostic_producer_sequence").on(
      t.traceId,
      t.producerId,
      t.producerSeq,
    ),
    index("diagnostic_trace_cursor").on(t.traceId, t.ingestSeq),
  ],
);

export const diagnosticLinks = sqliteTable(
  "diagnostic_links",
  {
    fromTrace: text("from_trace")
      .notNull()
      .references(() => diagnosticTraces.id, { onDelete: "cascade" }),
    toTrace: text("to_trace")
      .notNull()
      .references(() => diagnosticTraces.id, { onDelete: "cascade" }),
    relation: text().notNull(),
  },
  (t) => [unique("diagnostic_link").on(t.fromTrace, t.toTrace, t.relation)],
);

export const diagnosticArtifacts = sqliteTable(
  "diagnostic_artifacts",
  {
    ingestSeq: integer("ingest_seq").primaryKey({ autoIncrement: true }),
    id: text().notNull().unique(),
    traceId: text("trace_id")
      .notNull()
      .references(() => diagnosticTraces.id, { onDelete: "cascade" }),
    spanId: text("span_id").notNull(),
    objectKey: text("object_key").notNull(),
    digest: text().notNull(),
    bytes: integer().notNull(),
    expiresAt: integer("expires_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("diagnostic_artifact_trace").on(t.traceId),
    index("diagnostic_artifact_expiry").on(t.expiresAt),
  ],
);

// Provider accounts can change independently of the user ID used by Tailos data.
export const users = sqliteTable("users", {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const mcpKeys = sqliteTable(
  "mcp_keys",
  {
    id: text().primaryKey().notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    prefix: text().notNull(),
    sha256: text().notNull().unique(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("mcp_key_owner").on(t.ownerId, t.createdAt)],
);

export const authAccounts = sqliteTable(
  "auth_accounts",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text(),
    password: text(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    unique("auth_provider_account").on(t.providerId, t.accountId),
    index("auth_account_user").on(t.userId),
  ],
);

// Browser login state expires independently of the conversation rows in sessions.
export const loginSessions = sqliteTable(
  "login_sessions",
  {
    id: text().primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("login_session_user").on(t.userId)],
);

export const authVerifications = sqliteTable(
  "auth_verifications",
  {
    id: text().primaryKey().notNull(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("auth_verification_identifier").on(t.identifier)],
);

// Migrations maintain issue_notification_terminal: every terminal runs.status
// transition advances desired_state/version atomically with the run update.
export const issueNotifications = sqliteTable(
  "issue_notifications",
  {
    runId: text("run_id")
      .primaryKey()
      .notNull()
      .references(() => runs.id),
    commentId: integer("comment_id"),
    desiredState: text("desired_state").notNull().default("processing"),
    version: integer().notNull().default(1),
    appliedVersion: integer("applied_version").notNull().default(0),
    attempts: integer().notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    lease: text(),
    leaseUntil: integer("lease_until"),
    errorCategory: text("error_category"),
  },
  (t) => [index("issue_notification_due").on(t.nextAttemptAt)],
);

/**
 * Messages for a Session, kept in the order they arrived. A message becomes a
 * Turn (`run_id`) once the Session has no Turn in progress, so a message that
 * waits does not use up its time limit.
 */
export const sessionInbox = sqliteTable(
  "session_inbox",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    source: text().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    deliveryId: text("delivery_id"),
    routineId: text("routine_id").references(() => routines.id),
    routineRevision: integer("routine_revision"),
    authorKind: text("author_kind", {
      enum: ["user", "automation"],
    }).notNull(),
    body: text().notNull(),
    executionContext: text("execution_context").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    receivedAt: integer("received_at").notNull(),
    runId: text("run_id")
      .unique()
      .references(() => runs.id),
  },
  (t) => [
    unique("session_inbox_delivery").on(t.source, t.idempotencyKey),
    index("session_inbox_waiting")
      .on(t.sessionId, t.id)
      .where(sql`${t.runId} is null`),
  ],
);

/** The one Session a Routine keeps for an issue. */
export const routineSessions = sqliteTable(
  "routine_sessions",
  {
    ownerId: text("owner_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id),
    repositoryId: integer("repository_id").notNull(),
    issueNumber: integer("issue_number").notNull(),
    sessionId: text("session_id")
      .notNull()
      .unique()
      .references(() => sessions.id),
    lastMessageAt: integer("last_message_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.ownerId,
        t.projectId,
        t.routineId,
        t.repositoryId,
        t.issueNumber,
      ],
    }),
    index("routine_session_issue").on(
      t.projectId,
      t.repositoryId,
      t.issueNumber,
      t.lastMessageAt,
    ),
  ],
);

/**
 * How to start a Session, sent once in reply to a comment that cannot
 * continue one.
 */
export const issueGuidance = sqliteTable(
  "issue_guidance",
  {
    id: text().primaryKey().notNull(),
    target: text().notNull(),
    trigger: text().notNull(),
    body: text().notNull(),
    commentId: integer("comment_id"),
    state: text({ enum: ["pending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    lease: text(),
    leaseUntil: integer("lease_until"),
    errorCategory: text("error_category"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("issue_guidance_due").on(t.nextAttemptAt)],
);

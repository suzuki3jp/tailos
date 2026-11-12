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

export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    projectId: text("project_id"),
    target: text(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("session_owner_created").on(t.ownerId, t.createdAt, t.id)],
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
    index("run_next_action")
      .on(t.nextActionAt, t.id)
      .where(sql`${t.status} in ('queued', 'running')`),
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

export const issueNotifications = sqliteTable(
  "issue_notifications",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    kind: text().notNull().default("issue-comment"),
    sessionId: text("session_id").notNull(),
    target: text().notNull(),
    commentId: integer("comment_id"),
    desiredState: text("desired_state").notNull().default("processing"),
    appliedState: text("applied_state"),
    version: integer().notNull().default(1),
    appliedVersion: integer("applied_version").notNull().default(0),
    attempts: integer().notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    lease: text(),
    leaseUntil: integer("lease_until"),
    errorCategory: text("error_category"),
  },
  (t) => [
    unique("issue_notification_run_kind").on(t.runId, t.kind),
    index("issue_notification_due").on(t.nextAttemptAt),
  ],
);

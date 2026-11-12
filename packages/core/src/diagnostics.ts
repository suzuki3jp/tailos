import * as v from "valibot";

const id = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
  v.regex(/^[a-zA-Z0-9_./:-]+$/),
);
const timestamp = v.pipe(
  v.number(),
  v.safeInteger(),
  v.minValue(1),
  v.maxValue(8_640_000_000_000_000),
);
export const maxDiagnosticBody = 128 * 1024;
export const maxDiagnosticBatch = 512 * 1024;
export const maxDiagnosticEvents = 10_000;
export const maxDiagnosticBytes = 32 * 1024 * 1024;
export const diagnosticGraceMs = 120_000;
export const diagnosticRetentionMs = 90 * 24 * 60 * 60_000;
export const diagnosticBodyRetentionMs = 30 * 24 * 60 * 60_000;

export const diagnosticContextSchema = v.strictObject({
  traceId: id,
  parentSpanId: id,
  producerId: v.pipe(v.string(), v.uuid()),
  url: v.pipe(v.string(), v.url()),
  bearer: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  expiresAt: timestamp,
});
export type DiagnosticContext = v.InferOutput<typeof diagnosticContextSchema>;

export const diagnosticAttributesSchema = v.strictObject({
  operation: v.optional(
    v.picklist([
      "request",
      "container",
      "runner",
      "checkout",
      "workspace",
      "agent",
      "initialize",
      "sandbox",
      "command",
      "file_change",
      "tool",
      "reply",
      "input",
      "publication",
      "commit",
      "pull_request",
      "cleanup",
      "refresh",
      "recovery",
    ]),
  ),
  outcome: v.optional(
    v.picklist([
      "started",
      "succeeded",
      "failed",
      "unknown",
      "ignored",
      "coalesced",
      "replayed",
      "running",
    ]),
  ),
  reason: v.optional(
    v.picklist([
      "event_type",
      "action",
      "invalid_event",
      "project_config",
      "repository",
      "installation",
      "label",
      "actor",
      "issue_state",
      "pull_request",
      "delivery",
      "operator",
      "schedule",
      "transport",
      "deadline",
      "limit",
      "redaction",
      "protocol",
    ]),
  ),
  exitCode: v.optional(v.pipe(v.number(), v.safeInteger())),
  durationMs: v.optional(v.pipe(v.number(), v.minValue(0))),
  httpStatus: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)),
  ),
  dropped: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
});
export type DiagnosticAttributes = v.InferOutput<
  typeof diagnosticAttributesSchema
>;

export const diagnosticRecordSchema = v.strictObject({
  eventId: v.pipe(v.string(), v.uuid()),
  spanId: id,
  parentSpanId: v.optional(id),
  requestId: v.optional(id),
  seq: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(maxDiagnosticEvents),
  ),
  at: timestamp,
  name: v.picklist([
    "span.started",
    "span.finished",
    "output",
    "capture.truncated",
  ]),
  attributes: diagnosticAttributesSchema,
  body: v.optional(v.pipe(v.string(), v.maxLength(maxDiagnosticBody))),
});
export type DiagnosticRecord = v.InferOutput<typeof diagnosticRecordSchema>;
export const diagnosticBatchSchema = v.strictObject({
  version: v.literal(1),
  batchId: v.pipe(v.string(), v.uuid()),
  producerId: v.pipe(v.string(), v.uuid()),
  records: v.pipe(v.array(diagnosticRecordSchema), v.maxLength(32)),
  completed: v.optional(
    v.strictObject({
      lastSeq: v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(0),
        v.maxValue(maxDiagnosticEvents),
      ),
      dropped: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    }),
  ),
});
export type DiagnosticBatch = v.InferOutput<typeof diagnosticBatchSchema>;
export const parseDiagnosticBatch = (input: unknown) =>
  v.parse(diagnosticBatchSchema, input);

export const runTraceId = (runId: string) => `run/${runId}`;

// A bound recorder never controls execution. Implementations isolate telemetry
// errors; business transitions and their required history stay in the RunStore.
export interface Diagnostics {
  start(
    operation: NonNullable<DiagnosticAttributes["operation"]>,
    body?: string,
    parentSpanId?: string,
  ): string;
  end(spanId: string, attributes?: DiagnosticAttributes, body?: string): void;
  output(spanId: string, body: string): void;
  addSecret(secret: string): void;
}

import * as v from "valibot";

export const executionContextSchema = v.variant("engine", [
  v.strictObject({ version: v.literal(1), engine: v.literal("fake") }),
  v.strictObject({
    version: v.literal(1),
    engine: v.literal("codex"),
    connectionId: v.literal("codex/default"),
  }),
]);

const job = {
  version: v.literal(1),
  runId: v.pipe(v.string(), v.uuid()),
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  deadlineAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
};

const secret = v.pipe(v.string(), v.minLength(1), v.maxLength(12_000));
export const codexAccessSchema = v.strictObject({
  accessToken: secret,
  accountId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  planType: v.optional(v.pipe(v.string(), v.maxLength(64))),
  connectionVersion: v.pipe(v.string(), v.uuid()),
  accessVersion: v.pipe(v.string(), v.uuid()),
});

export const runnerJobSchema = v.variant("engine", [
  v.strictObject({ ...job, engine: v.literal("fake") }),
  v.strictObject({
    ...job,
    engine: v.literal("codex"),
    access: codexAccessSchema,
    refresh: v.strictObject({
      url: v.pipe(v.string(), v.url()),
      bearer: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    }),
  }),
]);

export type CodexAccess = v.InferOutput<typeof codexAccessSchema>;
export type ExecutionContext = v.InferOutput<typeof executionContextSchema>;

export const runnerEventSchema = v.strictObject({
  type: v.picklist(["job_started", "job_succeeded", "job_failed"]),
  at: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

const events = v.pipe(v.array(runnerEventSchema), v.maxLength(20));

export const runnerStatusSchema = v.variant("status", [
  v.strictObject({ status: v.literal("running") }),
  v.strictObject({
    status: v.literal("succeeded"),
    reply: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
    events,
  }),
  v.strictObject({
    status: v.literal("failed"),
    errorCode: v.picklist(["agent_failed", "deadline_exceeded"]),
    events,
  }),
]);

export type RunnerJob = v.InferOutput<typeof runnerJobSchema>;
export type RunnerStatus = v.InferOutput<typeof runnerStatusSchema>;

export type RunnerEvent = v.InferOutput<typeof runnerEventSchema>;

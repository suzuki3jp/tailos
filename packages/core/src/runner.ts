import * as v from "valibot";

export const executionContextSchema = v.strictObject({
  version: v.literal(1),
  engine: v.literal("fake"),
});

export const runnerJobSchema = v.strictObject({
  version: v.literal(1),
  runId: v.pipe(v.string(), v.uuid()),
  engine: executionContextSchema.entries.engine,
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  deadlineAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

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

import * as v from "valibot";

export const timelinePageSize = 100;
export const timelineInlineBytes = 8 * 1024;
export const timelineDeliveryMs = 250;
export const timelineKind = v.picklist([
  "message",
  "command",
  "web",
  "tool",
  "file",
  "stage",
]);
export const timelineStatus = v.picklist([
  "running",
  "succeeded",
  "failed",
  "unknown",
]);
export const TimelineItem = v.object({
  id: v.string(),
  runId: v.string(),
  kind: timelineKind,
  label: v.nullable(v.string()),
  text: v.nullable(v.string()),
  status: timelineStatus,
  startedAt: v.number(),
  finishedAt: v.nullable(v.number()),
  durationMs: v.nullable(v.number()),
  exitCode: v.nullable(v.number()),
  revision: v.number(),
  bodyExpiresAt: v.number(),
  hasInput: v.boolean(),
  hasOutput: v.boolean(),
});
export type TimelineItem = v.InferOutput<typeof TimelineItem>;
export const TimelineSnapshot = v.object({
  items: v.array(TimelineItem),
  cursor: v.number(),
  before: v.nullable(v.number()),
  captures: v.array(
    v.object({ runId: v.string(), state: v.string(), dropped: v.number() }),
  ),
});
export type TimelineSnapshot = v.InferOutput<typeof TimelineSnapshot>;
export const TimelineChanges = v.object({
  type: v.literal("changes"),
  items: v.array(TimelineItem),
  cursor: v.number(),
  hasMore: v.boolean(),
  sessionChanged: v.boolean(),
  captureChanged: v.boolean(),
});
export type TimelineChanges = v.InferOutput<typeof TimelineChanges>;
export const TimelineClientMessage = v.variant("type", [
  v.object({
    type: v.literal("ack"),
    cursor: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.object({
    type: v.literal("resume"),
    after: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.object({ type: v.literal("ping") }),
]);
export const parseTimelineSnapshot = (input: unknown) =>
  v.parse(TimelineSnapshot, input);
export const parseTimelineMessage = (input: unknown) =>
  v.parse(
    v.variant("type", [
      TimelineChanges,
      v.object({ type: v.literal("reset_required") }),
      v.object({ type: v.literal("pong") }),
    ]),
    input,
  );

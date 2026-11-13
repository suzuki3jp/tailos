import {
  checkedPublicationFields,
  gitSha,
  replyText,
  RunnerEvent,
} from "@tailos/core/runner";
import * as v from "valibot";

export const LegacyPublication = v.strictObject({
  kind: v.picklist(["prepared", "pushed"]),
  branch: v.pipe(v.string(), v.maxLength(255)),
  sha: gitSha,
  reply: replyText,
  events: v.pipe(v.array(RunnerEvent), v.maxLength(20)),
});
export const checkedCheckpointSchema = v.strictObject({
  ...checkedPublicationFields,
  digest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export const PendingPublication = v.union([
  checkedCheckpointSchema,
  LegacyPublication,
]);
const stateSchema = v.object({
  pendingPublication: v.optional(PendingPublication),
  publicationStartedAt: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  ),
});

// Agent work stops at the Run deadline. Publishing already staged work gets a
// short window to reconcile GitHub and D1 after an ambiguous response.
export const publicationRecoveryMs = 30_000;

export type PendingPublication = v.InferOutput<typeof PendingPublication>;
export type LegacyPublication = v.InferOutput<typeof LegacyPublication>;

export function pendingPublication(
  stepState: string | null,
): PendingPublication | null {
  if (!stepState) return null;
  try {
    const state = v.safeParse(stateSchema, JSON.parse(stepState));
    return state.success ? (state.output.pendingPublication ?? null) : null;
  } catch {
    return null;
  }
}

// A prepared checkpoint is still Agent work until the Runner finishes its push.
// Reconciliation gets a bounded window starting when its first check begins.
export function publicationDeadline(
  stepState: string | null,
  runDeadline: number,
) {
  if (!stepState) return runDeadline;
  try {
    const state = v.parse(stateSchema, JSON.parse(stepState));
    if (state.publicationStartedAt) {
      return Math.min(
        state.publicationStartedAt + publicationRecoveryMs,
        runDeadline + publicationRecoveryMs,
      );
    }
    // Older pushed checkpoints predate the reconciliation timestamp.
    return state.pendingPublication?.kind === "pushed"
      ? runDeadline + publicationRecoveryMs
      : runDeadline;
  } catch {
    return runDeadline;
  }
}

import { gitSha, runnerEventSchema } from "@meguri/core/runner";
import * as v from "valibot";

export const pendingPublicationSchema = v.strictObject({
  kind: v.picklist(["prepared", "pushed"]),
  branch: v.pipe(v.string(), v.maxLength(255)),
  sha: gitSha,
  reply: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
  events: v.pipe(v.array(runnerEventSchema), v.maxLength(20)),
});
const stateSchema = v.object({
  pendingPublication: v.optional(pendingPublicationSchema),
});

// Agent work stops at the Run deadline. Publishing already staged work gets a
// short window to reconcile GitHub and D1 after an ambiguous response.
export const publicationRecoveryMs = 30_000;

export type PendingPublication = v.InferOutput<typeof pendingPublicationSchema>;

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

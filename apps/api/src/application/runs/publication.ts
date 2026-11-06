import { gitSha, runnerEventSchema } from "@meguri/core/runner";
import * as v from "valibot";

const stagedSchema = v.strictObject({
  kind: v.literal("pushed"),
  branch: v.pipe(v.string(), v.maxLength(255)),
  sha: gitSha,
  reply: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
  events: v.pipe(v.array(runnerEventSchema), v.maxLength(20)),
});
const stateSchema = v.object({ pendingPublication: v.optional(stagedSchema) });

export type PendingPublication = v.InferOutput<typeof stagedSchema>;

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

import * as v from "valibot";
import type { CodexRpc } from "@/codex-rpc.ts";

const modelSchema = v.object({
  model: v.pipe(v.string(), v.minLength(1)),
  isDefault: v.boolean(),
  supportedReasoningEfforts: v.array(
    v.object({ reasoningEffort: v.pipe(v.string(), v.minLength(1)) }),
  ),
});

export async function listCodexModels(rpc: CodexRpc) {
  const models: v.InferOutput<typeof modelSchema>[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = v.parse(
      v.object({
        data: v.array(modelSchema),
        nextCursor: v.optional(v.nullable(v.string())),
      }),
      await rpc.call("model/list", cursor ? { cursor } : {}),
    );
    models.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor))
      throw new Error("Model catalog pagination failed");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}

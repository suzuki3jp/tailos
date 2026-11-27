import * as v from "valibot";

/**
 * Tools Tailos no longer offers. A conversation from an earlier Turn may
 * still list them, so a call gets an answer instead of failing the Turn.
 */
const retired = {
  tailos_publish:
    "This tool no longer exists. Commit, push and open pull requests with git and gh, as the user and the repository's instructions ask.",
} as const;

export const retiredToolCallSchema = v.object({
  tool: v.picklist(Object.keys(retired) as (keyof typeof retired)[]),
});

/** What a retired tool answers, in the shape of a Codex dynamic tool result. */
export function retiredToolResult(tool: keyof typeof retired) {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: retired[tool] }],
  };
}

import * as v from "valibot";
import type { Publish, PublishOutcome } from "@/agent.ts";

/**
 * The Tailos publication tool. The Agent decides whether to publish: a Turn
 * that only answers or investigates leaves the repository as it is.
 */
export const publicationTool = {
  type: "function",
  name: "tailos_publish",
  description:
    "Publish the whole work tree of this Session to GitHub: Tailos checks the changes, makes a signed commit on this Session's branch and opens its pull request, or adds the commit to the pull request it already has. Give an English Conventional Commits headline of at most 100 characters that describes the changes since the last publication. Returns the pull request URL and the commit, or why nothing was published.",
  inputSchema: {
    type: "object",
    properties: {
      headline: { type: "string", maxLength: 100 },
    },
    required: ["headline"],
    additionalProperties: false,
  },
};

export const publicationToolCallSchema = v.object({
  threadId: v.string(),
  namespace: v.null(),
  tool: v.literal(publicationTool.name),
  arguments: v.unknown(),
});

const reasons: Record<
  Extract<PublishOutcome, { published: false }>["reason"],
  string
> = {
  no_changes:
    "Nothing was published: the work tree has no changes since the last publication.",
  in_progress:
    "Nothing was published: another publication is still in progress. Wait for it to finish.",
  invalid_change_headline:
    "Nothing was published: the headline must be an English Conventional Commits headline of at most 100 characters on one line, such as 'fix: handle an empty input'.",
  unsupported_changes:
    "Nothing was published: the changes cannot be signed by GitHub. New files must not be executable, file modes must not change, node_modules must not be included, and the files must stay under 4 MiB in total.",
  pull_request_merged:
    "Nothing was published: this Session's pull request has been merged, and publishing again after a merge is not available yet. Tell the user.",
  branch_moved:
    "Nothing was published: this Session's branch changed on GitHub outside this Session. Tell the user.",
  invalid_lease:
    "Nothing was published: this Turn may no longer publish. Tell the user.",
  invalid_publication:
    "Nothing was published: Tailos refused the publication. Tell the user.",
  publication_unavailable:
    "Nothing was published: publication is unavailable right now. You may try again once; otherwise tell the user.",
};

const toolResult = (success: boolean, text: string) => ({
  success,
  contentItems: [{ type: "inputText", text }],
});

/** Runs the publication tool and words its outcome for the Agent. */
export async function callPublicationTool(publish: Publish, input: unknown) {
  const headline = v.safeParse(v.strictObject({ headline: v.string() }), input);
  if (!headline.success)
    return toolResult(false, reasons.invalid_change_headline);
  try {
    const outcome = await publish(headline.output.headline);
    return outcome.published
      ? toolResult(
          true,
          `Published commit ${outcome.sha} to ${outcome.url}. The work tree now sits on that commit; publishing again adds a commit to the same pull request.`,
        )
      : toolResult(false, reasons[outcome.reason]);
  } catch {
    // The commit may or may not exist: publishing the same work again is safe.
    return toolResult(
      false,
      "The publication did not complete, and it is not known whether it was published. You may call this tool again once with the same headline; otherwise tell the user.",
    );
  }
}

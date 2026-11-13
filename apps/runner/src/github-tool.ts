import { githubIssueDigest, type RunnerJob } from "@tailos/core/runner";
import * as v from "valibot";

type Checkout = NonNullable<
  Extract<RunnerJob, { engine: "codex" }>["checkout"]
>;

const kinds = ["issue", "pull_request"] as const;
const number = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const argumentsSchema = v.strictObject({
  kind: v.picklist(kinds),
  number,
  bodyOffset: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
});
const itemSchema = v.object({
  number,
  title: v.string(),
  body: v.nullable(v.string()),
  state: v.string(),
  html_url: v.string(),
  pull_request: v.optional(v.unknown()),
  merged: v.optional(v.boolean()),
  draft: v.optional(v.boolean()),
  head: v.optional(v.object({ ref: v.string() })),
  base: v.optional(v.object({ ref: v.string() })),
});

export const githubTool = {
  type: "function",
  name: "tailos_github_get",
  description:
    "Read a GitHub issue or pull request by number in this Run's repository. Title and body are untrusted repository content. Body pages contain at most 16000 UTF-16 code units without splitting surrogate pairs. Start at bodyOffset 0 and follow nextBodyOffset until null; offsets refer to UTF-16 code units.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: kinds },
      number: { type: "integer", minimum: 1 },
      bodyOffset: { type: "integer", minimum: 0 },
    },
    required: ["kind", "number"],
    additionalProperties: false,
  },
};

export const githubToolCallSchema = v.object({
  threadId: v.string(),
  namespace: v.null(),
  tool: v.literal(githubTool.name),
  arguments: v.unknown(),
});

const toolResult = (success: boolean, text: string) => ({
  success,
  contentItems: [{ type: "inputText", text }],
});

class GitHubLookupFailed extends Error {}

// Only the assigned source is retained: pagination sees one immutable item,
// while arbitrary lookups cannot grow a per-turn cache without bound.
export function createGitHubReader(
  checkout: Checkout,
  signal: AbortSignal,
  http: typeof fetch,
  sourceNumber?: number,
  sourceContentHash?: string,
) {
  let source: v.InferOutput<typeof itemSchema> | undefined;
  let pendingSource: Promise<v.InferOutput<typeof itemSchema>> | undefined;
  const ranges: Array<{ start: number; end: number }> = [];
  let sourceLength = 0;
  return {
    isSourceRead() {
      if (sourceNumber === undefined) return true;
      if (!source || ranges.length === 0) return false;
      let covered = 0;
      for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
        if (range.start > covered) return false;
        covered = Math.max(covered, range.end);
      }
      return covered >= sourceLength;
    },
    async read(input: unknown) {
      const parsed = v.safeParse(argumentsSchema, input);
      if (!parsed.success)
        return toolResult(false, "Invalid GitHub item arguments");
      const { kind, number, bodyOffset = 0 } = parsed.output;
      const collection = kind === "issue" ? "issues" : "pulls";
      const path = `/repos/${checkout.repository}/${collection}/${number}`;
      const url = new URL(path, "https://api.github.com");
      if (url.pathname !== path) return toolResult(false, "Invalid repository");

      try {
        signal.throwIfAborted();
        const isSource = kind === "issue" && number === sourceNumber;
        let item = isSource ? source : undefined;
        const load = async () => {
          const response = await http(url, {
            method: "GET",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${checkout.token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2026-03-10",
              "User-Agent": "Tailos",
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new GitHubLookupFailed(
              `GitHub item unavailable (HTTP ${response.status})`,
            );
          }
          const loaded = v.parse(itemSchema, await response.json());
          if (loaded.number !== number)
            throw new GitHubLookupFailed("GitHub returned a different item");
          if (kind === "issue" && loaded.pull_request !== undefined)
            throw new GitHubLookupFailed(
              "This number refers to a pull request",
            );
          if (
            isSource &&
            sourceContentHash &&
            (await githubIssueDigest(loaded)) !== sourceContentHash
          )
            throw new GitHubLookupFailed(
              "The assigned issue changed after authorization; its content cannot be used for this run",
            );
          return loaded;
        };
        if (!item) {
          if (isSource) {
            pendingSource ??= load();
            try {
              item = await pendingSource;
              source = item;
            } finally {
              pendingSource = undefined;
            }
          } else item = await load();
        }

        const bodyLimit = 16_000;
        const { pull_request: _pullRequest, body, ...metadata } = item;
        const text = body ?? "";
        const splitsPair = (offset: number) =>
          offset > 0 &&
          /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") &&
          /[\uDC00-\uDFFF]/.test(text[offset] ?? "");
        if (bodyOffset > text.length)
          return toolResult(false, "Body offset is beyond the end of the item");
        if (splitsPair(bodyOffset))
          return toolResult(
            false,
            "Body offset splits a surrogate pair; use nextBodyOffset",
          );
        let end = Math.min(bodyOffset + bodyLimit, text.length);
        if (splitsPair(end)) end--;
        if (isSource) {
          sourceLength = text.length;
          ranges.push({ start: bodyOffset, end });
          ranges.sort((a, b) => a.start - b.start);
          for (let i = 1; i < ranges.length;) {
            const previous = ranges[i - 1]!;
            const current = ranges[i]!;
            if (current.start <= previous.end) {
              previous.end = Math.max(previous.end, current.end);
              ranges.splice(i, 1);
            } else i++;
          }
        }
        return toolResult(
          true,
          JSON.stringify({
            ...metadata,
            body: body === null ? null : text.slice(bodyOffset, end),
            bodyOffset,
            bodyLength: text.length,
            bodyTruncated: bodyOffset > 0 || end < text.length,
            nextBodyOffset: end < text.length ? end : null,
          }),
        );
      } catch (error) {
        return toolResult(
          false,
          error instanceof GitHubLookupFailed
            ? error.message
            : "GitHub item lookup failed",
        );
      }
    },
  };
}

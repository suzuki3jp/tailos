import * as v from "valibot";

const id = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const repository = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);
export const labelPayload = v.object({
  repository: v.object({
    id,
    full_name: repository,
    default_branch: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  }),
  installation: v.object({ id }),
  issue: v.object({
    number: id,
    title: v.string(),
    body: v.nullable(v.string()),
    state: v.string(),
    pull_request: v.optional(v.unknown()),
  }),
  label: v.object({ name: v.string() }),
  sender: v.object({ login: v.string() }),
});

export const commentPayload = v.object({
  repository: labelPayload.entries.repository,
  installation: labelPayload.entries.installation,
  issue: labelPayload.entries.issue,
  sender: v.object({ login: v.string(), type: v.string() }),
  comment: v.object({
    id,
    body: v.string(),
    html_url: v.pipe(v.string(), v.url()),
    user: v.object({ login: v.string(), type: v.string() }),
  }),
});

// Only an explicit command at the beginning of a new comment is executable.
// Indentation, blockquotes and fenced examples are not commands.
export function planningCommand(body: string) {
  const match = /^@tailos(?:[ \t]+|\r?\n)([\s\S]*?)\s*$/i.exec(body);
  if (!match || !match[1].trim()) return null;
  const text = match[1].trim();
  return { start: /^plan(?:\s|$)/i.test(text), text };
}

export function parseGithubEvent(
  eventType: string | undefined,
  event: unknown,
) {
  if (eventType !== "issues" && eventType !== "issue_comment")
    return { kind: "ignored", reason: "event_type" } as const;
  if (!event || typeof event !== "object" || !("action" in event))
    return { kind: "invalid" } as const;
  const comment = eventType === "issue_comment";
  if (event.action !== (comment ? "created" : "labeled"))
    return { kind: "ignored", reason: "action" } as const;
  if (comment) {
    const parsed = v.safeParse(commentPayload, event);
    if (!parsed.success) return { kind: "invalid" } as const;
    const data = parsed.output;
    const command = planningCommand(data.comment.body);
    if (!command) return { kind: "ignored", reason: "command" } as const;
    if (
      data.sender.type === "Bot" ||
      data.comment.user.type === "Bot" ||
      data.sender.login.toLowerCase() !== data.comment.user.login.toLowerCase()
    )
      return { kind: "ignored", reason: "actor" } as const;
    return { kind: "comment", data, command } as const;
  }
  const parsed = v.safeParse(labelPayload, event);
  return parsed.success
    ? ({ kind: "label", data: parsed.output } as const)
    : ({ kind: "invalid" } as const);
}

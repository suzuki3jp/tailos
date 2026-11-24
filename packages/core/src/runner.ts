import * as v from "valibot";
import { DiagnosticContext } from "./diagnostics.js";

export const maxPromptLength = 4000;
export const maxReplyLength = 8000;
export const sessionTitleText = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
  v.check((title) => !/[\p{Cc}\u2028\u2029]/u.test(title)),
);

// A title is auxiliary: invalid or older Runner values must not reject work.
export function normalizeSessionTitle(value: unknown): string | undefined {
  const parsed = v.safeParse(sessionTitleText, value);
  return parsed.success ? parsed.output : undefined;
}
export const optionalSessionTitle = v.optional(
  v.pipe(v.unknown(), v.transform(normalizeSessionTitle)),
);
export const promptText = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(maxPromptLength),
);
export const replyText = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(maxReplyLength),
);

const positiveId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const sha256 = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export async function githubIssueDigest(issue: {
  title: string;
  body: string | null;
}) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([issue.title, issue.body ?? ""]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const repositoryName = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);
export const gitSha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const branch = v.pipe(v.string(), v.minLength(1), v.maxLength(255));
// Earlier Runs had a branch each; a Session now publishes to its own, and to
// a numbered one after its pull request is merged.
export const workBranch = v.pipe(
  v.string(),
  v.regex(
    /^tailos\/(?:(?:issue-[1-9][0-9]*|run)\/[a-f0-9-]{36}|session\/[a-f0-9-]{36}(?:-[2-9]|-[1-9][0-9]+)?)$/,
  ),
);
/** The branch a Session publishes to; `n` counts its merged pull requests. */
export const sessionBranch = (sessionId: string, n = 1) =>
  `tailos/session/${sessionId}${n > 1 ? `-${n}` : ""}`;
export const changeHeadline = v.pipe(
  v.string(),
  v.maxLength(100),
  v.check((headline) => !/[\r\n]/.test(headline)),
  v.regex(
    /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([a-z0-9./_-]+\))?!?: [!-~](?:[ -~]*[!-~])?$/,
  ),
);
const gitPath = v.pipe(
  v.string(),
  v.maxLength(4096),
  v.check((path) =>
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git" &&
          !part.includes("\0"),
      ),
  ),
);
export const maxPublicationBytes = 4 * 1024 * 1024;
export const FileChanges = v.strictObject({
  additions: v.pipe(
    v.array(
      v.strictObject({
        path: gitPath,
        contents: v.pipe(
          v.string(),
          v.regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          ),
        ),
      }),
    ),
    v.maxLength(512),
  ),
  deletions: v.pipe(
    v.array(v.strictObject({ path: gitPath })),
    v.maxLength(512),
  ),
});
export type FileChanges = v.InferOutput<typeof FileChanges>;

export const RepositoryTarget = v.strictObject({
  repository: repositoryName,
  repositoryId: positiveId,
  installationId: positiveId,
  defaultBranch: branch,
});

const issueTrigger = {
  issueNumber: positiveId,
  issueContentHash: v.optional(sha256),
};
/** What started a Run. Each kind carries only the values it needs. */
export const RunTrigger = v.variant("kind", [
  v.strictObject({
    kind: v.literal("github.issue-label"),
    ...issueTrigger,
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
  }),
  v.strictObject({
    kind: v.literal("github.issue-comment"),
    ...issueTrigger,
  }),
  v.strictObject({ kind: v.literal("web.message") }),
]);
export type RunTrigger = v.InferOutput<typeof RunTrigger>;
export type IssueRunTrigger = Extract<RunTrigger, { issueNumber: number }>;

/** The GitHub issue a trigger refers to, if any. */
export function triggerIssue(
  trigger: RunTrigger | undefined,
): IssueRunTrigger | undefined {
  return trigger && "issueNumber" in trigger ? trigger : undefined;
}

export const ExecutionMode = v.picklist(["plan", "implement"]);
export const PlanResult = v.strictObject({
  planPresented: v.boolean(),
  needsAnswer: v.boolean(),
});
export type PlanResult = v.InferOutput<typeof PlanResult>;

export const codexOptions = {
  model: v.optional(v.pipe(v.string(), v.minLength(1))),
  effort: v.optional(v.pipe(v.string(), v.minLength(1))),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Stored Runs and planning inputs predate `trigger` and kept the issue values
// inside `repository`. Some also carry the removed per-Project network
// setting. Read them in the current shape without rewriting rows.
function upgradeStoredContext(input: unknown) {
  if (!isRecord(input) || !isRecord(input.repository)) return input;
  const { agentNetworkAccess: _removed, ...current } = input.repository;
  if (input.trigger !== undefined || current.issueNumber === undefined)
    return { ...input, repository: current };
  const { issueNumber, issueContentHash, triggerLabel, ...repository } =
    current;
  const issue = {
    issueNumber,
    ...(issueContentHash !== undefined && { issueContentHash }),
  };
  return {
    ...input,
    repository,
    trigger:
      input.mode === "plan"
        ? { kind: "github.issue-comment", ...issue }
        : { kind: "github.issue-label", ...issue, label: triggerLabel },
  };
}

const repositoryRun = {
  repository: v.optional(RepositoryTarget),
  trigger: v.optional(RunTrigger),
};

export const ExecutionContext = v.pipe(
  v.unknown(),
  v.transform(upgradeStoredContext),
  v.variant("engine", [
    v.strictObject({
      version: v.literal(1),
      engine: v.literal("fake"),
      mode: v.optional(ExecutionMode),
    }),
    v.strictObject({
      version: v.literal(1),
      engine: v.literal("codex"),
      ...codexOptions,
      routine: v.optional(
        v.strictObject({
          id: v.pipe(v.string(), v.uuid()),
          revision: positiveId,
          projectRevision: positiveId,
        }),
      ),
      mode: v.optional(ExecutionMode),
      connectionId: v.pipe(
        v.string(),
        v.regex(/^codex\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
      ),
      ...repositoryRun,
    }),
    v.strictObject({
      version: v.literal(1),
      engine: v.literal("claude"),
      mode: v.optional(ExecutionMode),
      connectionId: v.pipe(
        v.string(),
        v.regex(/^claude\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
      ),
      ...repositoryRun,
    }),
  ]),
  // A repository Run must say what started it; that decides issue handling.
  v.check(
    (context) =>
      !("repository" in context && context.repository) ||
      ("trigger" in context && context.trigger !== undefined),
  ),
);

export const maxRunnerJobBytes = 32 * 1024;

const job = {
  planningContext: v.optional(
    v.pipe(v.string(), v.maxLength(maxRunnerJobBytes)),
  ),
  mode: v.optional(ExecutionMode),
  version: v.literal(1),
  runId: v.pipe(v.string(), v.uuid()),
  prompt: promptText,
  deadlineAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  diagnostics: v.optional(DiagnosticContext),
};

const secret = v.pipe(v.string(), v.minLength(1), v.maxLength(12_000));
export const CodexAccess = v.strictObject({
  accessToken: secret,
  accountId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  planType: v.optional(v.pipe(v.string(), v.maxLength(64))),
  connectionVersion: v.pipe(v.string(), v.uuid()),
  accessVersion: v.pipe(v.string(), v.uuid()),
});

const repositoryJob = {
  githubContext: v.optional(
    v.strictObject({
      kind: v.literal("issue"),
      number: positiveId,
      contentHash: v.optional(sha256),
    }),
  ),
  checkout: v.optional(
    v.strictObject({
      repository: repositoryName,
      baseSha: gitSha,
      branch: workBranch,
      // The commit the Session last published to its branch, if any.
      publishedSha: v.optional(gitSha),
    }),
  ),
};
/** The largest saved work of a Session that the next Turn can restore. */
export const maxContinuityBytes = 100 * 1024 * 1024;
/**
 * How long saving the Turn's work may take after the Agent stops, beyond the
 * Run's own time limit.
 */
export const continuitySaveMs = 2 * 60_000;
/**
 * Carries a Session's work between its Turns. `restore` says what the previous
 * Turn left: its saved work, which the controller uploads before the job, or
 * nothing because saving it failed. A first Turn has no `restore`.
 */
export const RunnerContinuity = v.strictObject({
  restore: v.optional(v.picklist(["saved", "lost"])),
});
export type RunnerContinuity = v.InferOutput<typeof RunnerContinuity>;

// Authorizes the Runner to call back into its Run's controller.
const lease = v.strictObject({
  url: v.pipe(v.string(), v.url()),
  bearer: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
// A pasted long-lived token: it cannot be refreshed, so it has no version.
export const ClaudeAccess = v.strictObject({
  token: secret,
  connectionVersion: v.pipe(v.string(), v.uuid()),
});

export const RunnerJob = v.variant("engine", [
  v.strictObject({ ...job, engine: v.literal("fake") }),
  v.strictObject({
    ...job,
    ...repositoryJob,
    engine: v.literal("codex"),
    ...codexOptions,
    continuity: v.optional(RunnerContinuity),
    access: CodexAccess,
    // Also the base URL of the publication checkpoint.
    refresh: lease,
  }),
  v.strictObject({
    ...job,
    ...repositoryJob,
    engine: v.literal("claude"),
    access: ClaudeAccess,
    lease,
  }),
]);

export type CodexAccess = v.InferOutput<typeof CodexAccess>;
export type ClaudeAccess = v.InferOutput<typeof ClaudeAccess>;
export type ExecutionContext = v.InferOutput<typeof ExecutionContext>;

export const RunnerEvent = v.strictObject({
  type: v.picklist(["job_started", "job_succeeded", "job_failed"]),
  at: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

const events = v.pipe(v.array(RunnerEvent), v.maxLength(20));

export const RunnerPublication = v.variant("kind", [
  v.strictObject({ kind: v.literal("no_changes") }),
  v.strictObject({ kind: v.literal("checked") }),
  v.strictObject({
    kind: v.literal("pushed"),
    branch: workBranch,
    sha: gitSha,
  }),
]);

export const RunnerStatus = v.variant("status", [
  v.strictObject({ status: v.literal("running") }),
  v.strictObject({
    status: v.literal("succeeded"),
    reply: replyText,
    sessionTitle: optionalSessionTitle,
    publication: v.optional(RunnerPublication),
    plan: v.optional(PlanResult),
    events,
  }),
  v.strictObject({
    status: v.literal("failed"),
    errorCode: v.picklist([
      "agent_failed",
      "deadline_exceeded",
      "sandbox_unavailable",
      // Accept outcomes from Runner images that ran fixed publication checks.
      "format_check_failed",
      "lint_failed",
      "invalid_change_headline",
      "unsupported_changes",
    ]),
    events,
  }),
]);

export type RunnerJob = v.InferOutput<typeof RunnerJob>;
export type RunnerStatus = v.InferOutput<typeof RunnerStatus>;

export const checkedPublicationFields = {
  kind: v.literal("checked"),
  branch: workBranch,
  baseSha: gitSha,
  tree: gitSha,
  headline: changeHeadline,
  reply: replyText,
  sessionTitle: optionalSessionTitle,
  events,
};
export const CheckedPublication = v.strictObject({
  ...checkedPublicationFields,
  changes: FileChanges,
});
export type CheckedPublication = v.InferOutput<typeof CheckedPublication>;

/**
 * Work the Agent publishes with the publication tool during a Turn: the whole
 * work tree, as changes from `parentSha`, the head of the Session's branch.
 */
export const SessionPublication = v.strictObject({
  branch: workBranch,
  parentSha: gitSha,
  tree: gitSha,
  headline: changeHeadline,
  changes: FileChanges,
});
export type SessionPublication = v.InferOutput<typeof SessionPublication>;
/** What a publication made: the signed commit and its pull request. */
export const PublishedWork = v.strictObject({
  sha: gitSha,
  url: v.pipe(v.string(), v.url()),
});
export type PublishedWork = v.InferOutput<typeof PublishedWork>;
/**
 * Why a publication was refused, in words the Agent can act on. With
 * `parent_moved`, an earlier publication whose answer was lost already moved
 * the branch to `sha`: the Runner builds on it and publishes again.
 */
export const PublicationRefusal = v.union([
  v.strictObject({
    error: v.picklist([
      "pull_request_merged",
      "branch_moved",
      "invalid_lease",
      "invalid_publication",
      "publication_unavailable",
    ]),
  }),
  v.strictObject({ error: v.literal("parent_moved"), sha: gitSha }),
]);
export type PublicationRefusal = v.InferOutput<typeof PublicationRefusal>;

export type RunnerEvent = v.InferOutput<typeof RunnerEvent>;

export type RepositoryTarget = v.InferOutput<typeof RepositoryTarget>;
export type RunnerPublication = v.InferOutput<typeof RunnerPublication>;

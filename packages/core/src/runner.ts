import * as v from "valibot";
import { diagnosticContextSchema } from "./diagnostics.js";

const positiveId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const repositoryName = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);
export const gitSha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const branch = v.pipe(v.string(), v.minLength(1), v.maxLength(255));
export const workBranch = v.pipe(
  v.string(),
  v.regex(/^tailos\/issue-[1-9][0-9]*\/[a-f0-9-]{36}$/),
);
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
export const fileChangesSchema = v.strictObject({
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
export type FileChanges = v.InferOutput<typeof fileChangesSchema>;

const repositoryTarget = v.strictObject({
  repository: repositoryName,
  repositoryId: positiveId,
  installationId: positiveId,
  issueNumber: positiveId,
  defaultBranch: branch,
  triggerLabel: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
});

export const executionContextSchema = v.variant("engine", [
  v.strictObject({ version: v.literal(1), engine: v.literal("fake") }),
  v.strictObject({
    version: v.literal(1),
    engine: v.literal("codex"),
    connectionId: v.pipe(
      v.string(),
      v.regex(/^codex\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
    ),
    repository: v.optional(repositoryTarget),
  }),
]);

const job = {
  version: v.literal(1),
  runId: v.pipe(v.string(), v.uuid()),
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  deadlineAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  diagnostics: v.optional(diagnosticContextSchema),
};

const secret = v.pipe(v.string(), v.minLength(1), v.maxLength(12_000));
export const codexAccessSchema = v.strictObject({
  accessToken: secret,
  accountId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  planType: v.optional(v.pipe(v.string(), v.maxLength(64))),
  connectionVersion: v.pipe(v.string(), v.uuid()),
  accessVersion: v.pipe(v.string(), v.uuid()),
});

export const runnerJobSchema = v.variant("engine", [
  v.strictObject({ ...job, engine: v.literal("fake") }),
  v.strictObject({
    ...job,
    engine: v.literal("codex"),
    access: codexAccessSchema,
    checkout: v.optional(
      v.strictObject({
        repository: repositoryName,
        baseSha: gitSha,
        branch: workBranch,
        token: secret,
      }),
    ),
    refresh: v.strictObject({
      url: v.pipe(v.string(), v.url()),
      bearer: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    }),
  }),
]);

export type CodexAccess = v.InferOutput<typeof codexAccessSchema>;
export type ExecutionContext = v.InferOutput<typeof executionContextSchema>;

export const runnerEventSchema = v.strictObject({
  type: v.picklist(["job_started", "job_succeeded", "job_failed"]),
  at: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

const events = v.pipe(v.array(runnerEventSchema), v.maxLength(20));

const runnerPublicationSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("no_changes") }),
  v.strictObject({ kind: v.literal("checked") }),
  v.strictObject({
    kind: v.literal("pushed"),
    branch: workBranch,
    sha: gitSha,
  }),
]);

export const runnerStatusSchema = v.variant("status", [
  v.strictObject({ status: v.literal("running") }),
  v.strictObject({
    status: v.literal("succeeded"),
    reply: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
    publication: v.optional(runnerPublicationSchema),
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

export type RunnerJob = v.InferOutput<typeof runnerJobSchema>;
export type RunnerStatus = v.InferOutput<typeof runnerStatusSchema>;

export const checkedPublicationFields = {
  kind: v.literal("checked"),
  branch: workBranch,
  baseSha: gitSha,
  tree: gitSha,
  headline: changeHeadline,
  reply: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
  events,
};
export const checkedPublicationSchema = v.strictObject({
  ...checkedPublicationFields,
  changes: fileChangesSchema,
});
export type CheckedPublication = v.InferOutput<typeof checkedPublicationSchema>;

export type RunnerEvent = v.InferOutput<typeof runnerEventSchema>;

export type RepositoryTarget = v.InferOutput<typeof repositoryTarget>;
export type RunnerPublication = v.InferOutput<typeof runnerPublicationSchema>;

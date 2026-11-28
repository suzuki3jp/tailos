import {
  maxReplyLength,
  normalizeSessionTitle,
  replyText,
  type RunnerJob,
} from "@tailos/core/runner";
import * as v from "valibot";
import type { AgentResult } from "@/agent.ts";

export type RepositoryJob = Exclude<RunnerJob, { engine: "fake" }>;

const repositoryReplySchema = v.object({
  reply: v.string(),
  sessionTitle: v.optional(v.unknown()),
});

// The first input of a Run. `githubTool` is the name the Agent calls the
// Tailos tool by, which differs between Agent runtimes.
export function agentPrompt(job: RepositoryJob, githubTool: string) {
  const sourceContext = job.githubContext
    ? "\n\nJob context (JSON):\n" +
      JSON.stringify({ github: job.githubContext }) +
      `\nBefore doing the requested work, call ${githubTool} for this issue and read every body page by following nextBodyOffset until null. If retrieval fails, retry or report failure; do not guess the issue content.\n\n`
    : "";
  const sessionTitleInstruction = job.checkout
    ? "\n\nReturn sessionTitle with a concise, single-line summary of the conversation purpose in its primary language (1–100 UTF-16 code units, no control characters). If unavailable, use null."
    : "";
  return (
    sourceContext +
    workPrompt(job, githubTool) +
    sessionTitleInstruction +
    "\nDuring the work, provide concise progress messages at meaningful phase changes. Keep these separate from the final structured answer. Do not include credentials or private reasoning."
  );
}

// A Routine's prompt says what to do with the message someone wrote, such
// as an issue comment.
function routineMessage(job: RepositoryJob) {
  return job.message
    ? "\n\nThe message to answer, written by a user allowed to start this Routine:\n" +
        job.message
    : "";
}

// Every repository Turn gets the same instructions: whether it only reads or
// also changes, commits and pushes is up to the request.
function workPrompt(job: RepositoryJob, githubTool: string) {
  if (job.checkout) {
    return (
      job.prompt +
      routineMessage(job) +
      `\n\nUse ${githubTool} to look up issues or pull requests in the target repository when needed. ` +
      "When you change files, use the repository instructions and CI configuration to choose and run the applicable formatting, linting, and other verification commands in the workspace. " +
      "For pnpm repositories, run /opt/tailos-checks/node_modules/.bin/pnpm --version from outside the checkout to check the Runner's bundled version. " +
      "If that version satisfies the repository's requirements, use the bundled executable directly for dependency installation and verification. For those commands, keep its directory first on PATH and set pnpm_config_pm_on_fail=ignore so pnpm and nested scripts can use the same bundled version without resolving it again. " +
      "If dependency installation is blocked, still run the applicable checks that can use tools already on PATH. " +
      "Fix failures caused by your changes and rerun the affected checks on the final changes. " +
      "In reply, summarize your work. If you changed files, include the commands you ran and their results, and explain any applicable checks you could not run." +
      gitInstruction
    );
  }
  return job.prompt + routineMessage(job);
}

// The work tree is the Agent's: Tailos does not decide how work is delivered.
const gitInstruction =
  " The work tree is a git repository whose origin is the target repository, and git and gh are signed in to it. Whether and how to commit, push branches and open pull requests is up to the request and the repository's instructions. If you push or open a pull request, include its URL in reply.";

// JSON Schema of the final answer, or undefined when the answer is plain text.
export function replySchema(job: RepositoryJob) {
  if (!job.checkout) return undefined;
  return {
    type: "object",
    properties: {
      reply: { type: "string" },
      // Length and content validation are independent of the primary answer.
      sessionTitle: { type: ["string", "null"] },
    },
    required: ["reply", "sessionTitle"],
    additionalProperties: false,
  };
}

// Runs the Agent's turn, then asks it to shorten an answer that exceeds the
// reply limit. `turn` returns the raw final answer: JSON text when the job has
// a reply schema. `timeoutMs` is set on shortening turns that must be cut off
// to keep time for publication. Resolves only when the Agent succeeded.
export async function runAgentTurns(options: {
  job: RepositoryJob;
  signal: AbortSignal;
  prompt: string;
  sensitive: Iterable<string>;
  failure?: () => Error | undefined;
  turn: (
    prompt: string,
    revision: number,
    timeoutMs: number | undefined,
  ) => Promise<string>;
}): Promise<AgentResult> {
  const { job, signal, sensitive, turn } = options;
  const redact = (text: string) => {
    for (const secret of sensitive)
      text = text.replaceAll(secret, "[REDACTED]");
    return text;
  };
  let prompt = options.prompt;
  let sessionTitle: string | undefined;
  // A repository Turn may have changed its work, which a failed summary must
  // not discard.
  const repository = !!job.checkout;
  const finalReply = (text: string) => ({
    reply: text,
    ...(sessionTitle && { sessionTitle }),
  });
  const workFallback = () =>
    // Summary failure must not discard completed code or silently truncate
    // the answer.
    finalReply(
      v.parse(
        replyText,
        `Agent の作業は完了しましたが、最終説明文が ${maxReplyLength} 文字の上限を超え、要約を取得できませんでした。`,
      ),
    );
  const parseReply = (reply: string) => {
    if (job.checkout) return v.parse(repositoryReplySchema, JSON.parse(reply));
    return { reply };
  };
  for (let revision = 0; ; revision++) {
    signal.throwIfAborted();
    const failure = options.failure?.();
    if (failure) {
      if (repository && revision > 0) return workFallback();
      throw failure;
    }
    if (repository && revision > 0 && job.deadlineAt - Date.now() < 60_000)
      return workFallback();
    let result: ReturnType<typeof parseReply>;
    try {
      result = parseReply(
        await turn(
          prompt,
          revision,
          // Reserve at least 30 seconds for saving the work.
          repository && revision > 0
            ? Math.min(30_000, job.deadlineAt - Date.now() - 30_000)
            : undefined,
        ),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (repository && revision > 0) return workFallback();
      throw error;
    }
    if (!sessionTitle && "sessionTitle" in result) {
      const raw = result.sessionTitle;
      if (typeof raw === "string" && redact(raw) === raw)
        sessionTitle = normalizeSessionTitle(raw);
    }
    const text = redact(result.reply);
    if (text.length > maxReplyLength) {
      const exhausted = revision >= 2;
      const insufficientTime =
        job.deadlineAt - Date.now() < (repository ? 60_000 : 5_000);
      if (!exhausted && !insufficientTime) {
        prompt = `Your reply contains ${text.length} UTF-16 code units after redaction, exceeding the ${maxReplyLength} limit. Rewrite only the previous answer, aiming for ${maxReplyLength - 1000} UTF-16 code units or fewer. Preserve the essential plan, assumptions, questions and verification results. Do not investigate again, run checks, use tools or change files. Return the same response format.`;
        continue;
      }
      if (repository) return workFallback();
      throw new Error(
        exhausted
          ? "Agent reply remains too long"
          : "Insufficient time to shorten agent reply",
      );
    }
    return finalReply(v.parse(replyText, text));
  }
}

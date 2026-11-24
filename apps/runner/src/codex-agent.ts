import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import type { RunnerJob } from "@tailos/core/runner";
import * as v from "valibot";
import type { Diagnostics } from "@tailos/core/diagnostics";
import { supportsCodexSelection } from "@tailos/core/models";
import {
  AgentSandboxUnavailable,
  type AgentAdapter,
  type Conversation,
  type Publish,
} from "@/agent.ts";
import { rolloutPath } from "@/continuity.ts";
import { agentPrompt, replySchema, runAgentTurns } from "@/agent-turns.ts";
import { CodexRpc, type CodexProcess } from "@/codex-rpc.ts";
import {
  diagnosticErrorBody,
  withDiagnosticSpan,
} from "@/diagnostic-operations.ts";
import {
  createGitHubReader,
  githubTool,
  githubToolCallSchema,
} from "@/github-tool.ts";
import { prepareGitHubCli, trustEnvironment } from "@/egress.ts";
import {
  callPublicationTool,
  publicationTool,
  publicationToolCallSchema,
} from "@/publication-tool.ts";

const threadSchema = v.object({
  thread: v.object({
    id: v.string(),
    path: v.optional(v.nullable(v.string())),
  }),
  model: v.optional(v.string()),
  modelProvider: v.optional(v.string()),
});
const sandboxProbeSchema = v.object({
  exitCode: v.pipe(v.number(), v.safeInteger()),
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
});
const messageSchema = v.object({
  threadId: v.string(),
  item: v.object({ type: v.literal("agentMessage"), text: v.string() }),
});
// Codex explains a failed turn here; without it every failure looks the same.
const turnErrorSchema = v.object({
  message: v.string(),
  codexErrorInfo: v.optional(v.nullable(v.unknown())),
  additionalDetails: v.optional(v.nullable(v.string())),
});
type TurnError = v.InferOutput<typeof turnErrorSchema>;
const completedSchema = v.object({
  threadId: v.string(),
  turn: v.object({
    status: v.string(),
    error: v.optional(v.nullable(turnErrorSchema)),
  }),
});
const errorNotificationSchema = v.object({
  threadId: v.string(),
  willRetry: v.optional(v.boolean()),
  error: turnErrorSchema,
});

const maxTurnErrorText = 2_000;

/** Tells the Agent that it starts over, so it can tell the user. */
const lostWorkNotice =
  "Note: the work tree and conversation from this Session's previous turn could not be restored. You are starting from the repository's base commit without the earlier changes or conversation. Mention this to the user in your reply.\n\n";
/** The work tree is back but the conversation is not: say exactly that. */
const lostConversationNotice =
  "Note: the conversation from this Session's previous turn could not be restored, but the work tree is as the previous turn left it, including its changes. Review the current changes before continuing, and mention to the user that the earlier conversation is unavailable.\n\n";

function turnErrorCategory(info: TurnError["codexErrorInfo"]) {
  if (info == null) return "unknown";
  if (typeof info === "string") return info;
  return JSON.stringify(info);
}

/** Why Codex failed a turn, in Codex's own words and category. */
export class CodexTurnError extends Error {
  override name = "CodexTurnError";
  constructor(error: TurnError) {
    const category = turnErrorCategory(error.codexErrorInfo);
    const details = error.additionalDetails
      ? ` (${error.additionalDetails.slice(0, maxTurnErrorText)})`
      : "";
    super(`${category}: ${error.message.slice(0, maxTurnErrorText)}${details}`);
  }
}

function diagnosticOperation(itemType: string) {
  switch (itemType) {
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file_change";
    case "agentMessage":
      return "reply";
    case "mcpToolCall":
    case "webSearch":
      return "tool";
    default:
      return undefined;
  }
}

function diagnosticOutcome(
  item: { exitCode?: number | null; status?: string },
  operation: NonNullable<ReturnType<typeof diagnosticOperation>>,
) {
  if (item.exitCode != null)
    return item.exitCode === 0 ? "succeeded" : "failed";
  if (item.status === "failed") return "failed";
  if (operation === "reply" || item.status === "completed") return "succeeded";
  return "unknown";
}

type LaunchCodex = (
  directory: string,
  workspace: string,
  environment?: string,
) => CodexProcess;
const launchCodex: LaunchCodex = (directory, workspace, environment) => {
  const shellEnvironment = environment
    ? {
        HOME: join(environment, "home"),
        TMPDIR: join(environment, "tmp"),
        XDG_RUNTIME_DIR: join(environment, "runtime"),
        XDG_CACHE_HOME: join(environment, "cache"),
        PNPM_HOME: join(environment, "tools"),
        npm_config_prefix: join(environment, "tools"),
        PATH: [
          join(environment, "tools", "bin"),
          join(environment, "tools"),
          process.env.PATH,
        ].join(delimiter),
        ...trustEnvironment(),
      }
    : {};
  return spawn(
    "codex",
    [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      "analytics.enabled=false",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      "features.plugins=false",
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      ...Object.entries(shellEnvironment).flatMap(([name, value]) => [
        "-c",
        `shell_environment_policy.set.${name}=${JSON.stringify(value)}`,
      ]),
      "-c",
      `projects={${JSON.stringify(workspace)}={trust_level="untrusted"}}`,
    ],
    {
      cwd: directory,
      detached: true,
      env: {
        PATH: process.env.PATH,
        CODEX_HOME: directory,
        // Codex reaches the model API through the interception that adds the
        // Run's token, so it must trust the same CA as the Agent's commands.
        ...trustEnvironment(),
        npm_config_verify_deps_before_run: "false",
        pnpm_config_verify_deps_before_run: "false",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
};

export function createCodexAgent(
  launch = launchCodex,
  http = fetch,
): AgentAdapter {
  return {
    async run(job, signal, cwd, diagnostics, conversation, publish) {
      if (job.engine !== "codex") throw new Error("Invalid Codex job");
      const root = await mkdtemp(join(tmpdir(), "tailos-codex-"));
      // Outside the Agent's writable roots, and rebuilt every Turn: only the
      // conversation itself is carried over.
      const directory = join(root, "codex");
      const environment = job.checkout ? join(root, "environment") : undefined;
      let thread: { id: string; path?: string } | undefined;
      try {
        signal.throwIfAborted();
        await mkdir(directory);
        const resume = conversation?.resume;
        if (resume) {
          const path = join(directory, v.parse(rolloutPath, resume.path));
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, resume.content, { mode: 0o600 });
        }
        if (environment) {
          await Promise.all(
            ["home", "tmp", "runtime", "cache", "tools/bin"].map((path) =>
              mkdir(join(environment, path), { recursive: true, mode: 0o700 }),
            ),
          );
          await prepareGitHubCli(join(environment, "home"));
        }
        return await runTurn(
          launch(directory, cwd ?? directory, environment),
          cwd ?? directory,
          job,
          signal,
          http,
          environment,
          diagnostics,
          conversation && {
            ...conversation,
            started: (started) => {
              thread = started;
            },
          },
          publish,
        );
      } finally {
        // Codex may not report the path of a resumed thread: it is where
        // the rollout was restored.
        const path =
          thread?.path ??
          (thread && thread.id === conversation?.resume?.threadId
            ? join(directory, conversation.resume.path)
            : undefined);
        if (conversation && thread && path)
          await saveConversation(directory, thread.id, path, conversation);
        await withDiagnosticSpan(
          diagnostics,
          "cleanup",
          () => rm(root, { recursive: true, force: true }),
          JSON.stringify({ target: "codex_environment" }),
        );
      }
    },
  };
}

/** What the Agent must know about the previous Turn before it starts. */
/** Tells the Agent that its work moved onto the latest default branch. */
function realignNotice(realigned: NonNullable<Conversation["realigned"]>) {
  const merged =
    "Note: this Session's pull request has been merged. The work tree now starts from the latest default branch, and the next publication opens a new pull request. ";
  return realigned.kept
    ? merged +
        `Work that had not been published yet conflicts with the default branch, so it was not re-applied: it is kept at ${realigned.kept} for this turn only. Compare it with \`git diff ${realigned.publishedSha} ${realigned.kept}\`, carry over what the user still wants, and mention this to the user.\n\n`
    : merged +
        "Work that had not been published yet, if any, was re-applied on top as uncommitted changes. Mention this to the user.\n\n";
}

function continuityNotice(
  lostWork: boolean,
  lostConversation: boolean,
  realigned?: Conversation["realigned"],
) {
  if (lostWork) return lostWorkNotice;
  return (
    (lostConversation ? lostConversationNotice : "") +
    (realigned ? realignNotice(realigned) : "")
  );
}

/** Hands the thread's rollout to the Turn's saved work; never fails the Turn. */
async function saveConversation(
  directory: string,
  threadId: string,
  path: string,
  conversation: Conversation,
) {
  // Codex reports the real path, which differs under a symbolic link.
  const real = await realpath(path).catch(() => path);
  const home = await realpath(directory).catch(() => directory);
  const saved = v.safeParse(rolloutPath, relative(home, real));
  if (!saved.success) return;
  const content = await readFile(path).catch(() => undefined);
  if (content) conversation.save({ threadId, path: saved.output, content });
}

async function initialize(rpc: CodexRpc) {
  await rpc.call("initialize", {
    clientInfo: { name: "tailos", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized");
}

async function runTurn(
  child: CodexProcess,
  cwd: string,
  job: Extract<RunnerJob, { engine: "codex" }>,
  signal: AbortSignal,
  http: typeof fetch,
  environment?: string,
  diagnostics?: Diagnostics,
  conversation?: Conversation & {
    started(thread: { id: string; path?: string }): void;
  },
  publish?: Publish,
) {
  // Commands may always reach the internet: GitHub credentials are added
  // outside the container, so none are here to send.
  const sandboxPolicy =
    environment && job.mode !== "plan"
      ? {
          type: "workspaceWrite" as const,
          writableRoots: [cwd, environment],
          networkAccess: true,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        }
      : { type: "readOnly" as const, networkAccess: true };
  const rpc = new CodexRpc(child);
  if (job.githubContext && !job.checkout) {
    rpc.close();
    throw new Error("GitHub issue context requires a repository checkout");
  }
  const githubReader = job.checkout
    ? createGitHubReader(
        job.checkout,
        signal,
        http,
        job.githubContext?.number,
        job.githubContext?.contentHash,
      )
    : undefined;
  const abort = () => rpc.close();
  signal.addEventListener("abort", abort, { once: true });
  const access = job.access;
  let threadId: string | undefined;
  let reply = "";
  const agentSpan = diagnostics?.start(
    "agent",
    JSON.stringify({
      engine: "codex",
      version: process.env.TAILOS_CODEX_VERSION ?? "unknown",
      sandbox:
        job.checkout && job.mode !== "plan" ? "workspace-write" : "read-only",
    }),
  );
  let agentSucceeded = false;
  let agentError: unknown;
  const itemSpans = new Map<string, string>();
  const diagnosticItemSchema = v.object({
    threadId: v.string(),
    item: v.object({
      id: v.optional(v.string()),
      type: v.string(),
      phase: v.optional(v.nullable(v.string())),
      command: v.optional(v.string()),
      cwd: v.optional(v.string()),
      aggregatedOutput: v.optional(v.nullable(v.string())),
      exitCode: v.optional(v.nullable(v.pipe(v.number(), v.safeInteger()))),
      text: v.optional(v.string()),
      tool: v.optional(v.string()),
      server: v.optional(v.string()),
      arguments: v.optional(v.unknown()),
      result: v.optional(v.unknown()),
      query: v.optional(v.string()),
      status: v.optional(v.string()),
      changes: v.optional(
        v.array(v.object({ path: v.string(), diff: v.optional(v.string()) })),
      ),
    }),
  });
  const sensitive = new Set([access.accessToken, job.refresh.bearer]);
  const loginParams = () => ({
    accessToken: access.accessToken,
    chatgptAccountId: access.accountId,
    chatgptPlanType: access.planType,
  });

  let resolveTurn = () => {};
  let rejectTurn = (_error: Error) => {};
  let failure: Error | undefined;
  let lastTurnError: TurnError | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    rejectTurn(error);
  };
  rpc.onFailure = fail;
  rpc.onRequest = async (method, params) => {
    if (
      method === "item/tool/call" &&
      publish &&
      threadId &&
      v.is(publicationToolCallSchema, params)
    ) {
      if (params.threadId !== threadId)
        throw new Error("Unexpected tool thread");
      // The publication span records the outcome; the tool span only the call.
      const span = diagnostics?.start(
        "tool",
        JSON.stringify({ name: publicationTool.name }),
        agentSpan,
      );
      const result = await callPublicationTool(publish, params.arguments);
      if (span)
        diagnostics?.end(span, {
          outcome: result.success ? "succeeded" : "failed",
        });
      return result;
    }
    if (method === "item/tool/call" && githubReader && threadId) {
      const call = v.parse(githubToolCallSchema, params);
      if (call.threadId !== threadId) throw new Error("Unexpected tool thread");
      const span = diagnostics?.start(
        "tool",
        JSON.stringify({
          name: "tailos_github_get",
          arguments: call.arguments,
        }),
        agentSpan,
      );
      try {
        const { diagnosticReason, ...result } = await githubReader.read(
          call.arguments,
        );
        if (span) {
          try {
            diagnostics?.end(
              span,
              {
                outcome: result.success ? "succeeded" : "failed",
                ...(diagnosticReason ? { reason: diagnosticReason } : {}),
              },
              JSON.stringify(result),
            );
          } catch {
            // Recording diagnostics must not change the tool result or turn.
          }
        }
        return result;
      } catch (error) {
        if (span) diagnostics?.end(span, { outcome: "failed" });
        throw error;
      }
    }
    if (method !== "account/chatgptAuthTokens/refresh") {
      if (job.mode === "plan")
        fail(new Error("Interactive planning requests are disabled"));
      throw new Error("Interactive requests are disabled");
    }

    // The token is a placeholder: the model egress Worker outside the
    // container adds the real one and refreshes it when the API rejects it.
    return loginParams();
  };
  rpc.onNotification = (method, params) => {
    if (
      diagnostics &&
      (method === "item/started" || method === "item/completed")
    ) {
      const parsed = v.safeParse(diagnosticItemSchema, params);
      if (parsed.success && parsed.output.threadId === threadId) {
        const item = parsed.output.item;
        const operation = diagnosticOperation(item.type);
        if (operation) {
          const id = item.id ?? "reply";
          let span = itemSpans.get(id);
          if (!span && itemSpans.size < 1000) {
            span = diagnostics.start(
              operation,
              JSON.stringify({
                command: item.command,
                cwd: item.cwd,
                tool: item.tool,
                server: item.server,
                arguments: item.arguments,
                query: item.query,
              }),
              agentSpan,
              {
                ...(item.type === "webSearch" && { toolKind: "web" as const }),
              },
            );
            itemSpans.set(id, span);
          }
          if (span && method === "item/completed") {
            diagnostics.end(
              span,
              {
                outcome: diagnosticOutcome(item, operation),
                ...(operation === "reply" && {
                  messagePhase:
                    item.phase === "commentary"
                      ? ("commentary" as const)
                      : ("unknown" as const),
                }),
                ...(item.exitCode == null ? {} : { exitCode: item.exitCode }),
              },
              JSON.stringify({
                output: item.aggregatedOutput,
                text: item.text,
                changes: item.changes,
                tool: item.tool,
                server: item.server,
                arguments: item.arguments,
                result: item.result,
                query: item.query,
              }),
            );
            itemSpans.delete(id);
          }
        }
      }
    }
    if (method === "item/completed") {
      const item = v.safeParse(messageSchema, params);
      if (item.success && item.output.threadId === threadId)
        reply = item.output.item.text;
    }
    if (method === "error") {
      const notice = v.safeParse(errorNotificationSchema, params);
      if (!notice.success || notice.output.threadId !== threadId) return;
      lastTurnError = notice.output.error;
      if (agentSpan) {
        try {
          // Retried errors are kept too: they show what led to a failure.
          diagnostics?.output(
            agentSpan,
            JSON.stringify({
              codexError: notice.output.error,
              willRetry: notice.output.willRetry ?? false,
            }),
          );
        } catch {
          // Recording diagnostics must not change the turn.
        }
      }
    }
    if (method === "turn/completed") {
      const turn = v.parse(completedSchema, params);
      if (turn.threadId !== threadId) return;
      if (turn.turn.status === "completed") resolveTurn();
      else {
        const reason = turn.turn.error ?? lastTurnError;
        fail(
          new Error(
            "Codex turn failed",
            reason && { cause: new CodexTurnError(reason) },
          ),
        );
      }
    }
  };

  try {
    signal.throwIfAborted();
    await initialize(rpc);
    const sandboxSpan = diagnostics?.start(
      "sandbox",
      JSON.stringify({ command: ["/bin/true"], cwd }),
      agentSpan,
    );
    let probe;
    try {
      probe = v.parse(
        sandboxProbeSchema,
        await rpc.call("command/exec", {
          command: ["/bin/true"],
          cwd,
          timeoutMs: 5_000,
          sandboxPolicy,
        }),
      );
    } catch (error) {
      if (sandboxSpan) diagnostics?.end(sandboxSpan, { outcome: "failed" });
      throw error;
    }
    if (sandboxSpan)
      diagnostics?.end(
        sandboxSpan,
        {
          outcome: probe.exitCode === 0 ? "succeeded" : "failed",
          exitCode: probe.exitCode,
        },
        JSON.stringify({ stdout: probe.stdout, stderr: probe.stderr }),
      );
    if (probe.exitCode !== 0) {
      throw new AgentSandboxUnavailable("Codex command sandbox unavailable");
    }
    await rpc.call("account/login/start", {
      type: "chatgptAuthTokens",
      ...loginParams(),
    });
    if (supportsCodexSelection(job.model, job.effort))
      throw new Error("Requested model or effort is unavailable");
    const threadOptions = {
      cwd,
      ...(job.model && { model: job.model }),
      approvalPolicy: "never",
      sandbox:
        job.checkout && job.mode !== "plan" ? "workspace-write" : "read-only",
    };
    const lostWork = conversation?.lost ?? false;
    let lostConversation = false;
    let thread: v.InferOutput<typeof threadSchema> | undefined;
    if (conversation?.resume) {
      // The rollout brings back the earlier turns and the dynamic tools.
      thread = await rpc
        .call("thread/resume", {
          threadId: conversation.resume.threadId,
          ...threadOptions,
        })
        .then((result) => v.parse(threadSchema, result))
        .catch((error: unknown) => {
          // Shown with the other carry-over steps, so the cause can be found.
          const span = diagnostics?.start(
            "continuity",
            JSON.stringify({ target: "conversation" }),
            agentSpan,
          );
          if (span)
            diagnostics?.end(
              span,
              { outcome: "failed" },
              diagnosticErrorBody(error),
            );
          return undefined;
        });
      lostConversation = !thread;
    }
    thread ??= v.parse(
      threadSchema,
      await rpc.call("thread/start", {
        ...threadOptions,
        // A Session's conversation is kept for its next Turn.
        ephemeral: !conversation,
        ...(job.checkout && {
          dynamicTools: [githubTool, ...(publish ? [publicationTool] : [])],
        }),
      }),
    );
    threadId = thread.thread.id;
    conversation?.started({
      id: thread.thread.id,
      ...(thread.thread.path && { path: thread.thread.path }),
    });
    if (agentSpan && (thread.model || thread.modelProvider))
      diagnostics?.output(
        agentSpan,
        JSON.stringify({
          model: thread.model,
          modelProvider: thread.modelProvider,
        }),
      );
    const outputSchema = replySchema(job);
    const result = await runAgentTurns({
      job,
      signal,
      prompt:
        continuityNotice(lostWork, lostConversation, conversation?.realigned) +
        agentPrompt(
          job,
          githubTool.name,
          publish ? publicationTool.name : undefined,
        ),
      sensitive,
      failure: () => failure,
      async turn(prompt, revision, timeoutMs) {
        reply = "";
        // Arm a new completion before turn/start: notifications can arrive
        // before the RPC response. Never reuse a previous turn's reply or
        // completion.
        lastTurnError = undefined;
        const completed = new Promise<void>((resolve, reject) => {
          resolveTurn = resolve;
          rejectTurn = reject;
        });
        void completed.catch(() => {});
        const inputSpan = diagnostics?.start("input", prompt, agentSpan);
        if (inputSpan) diagnostics?.end(inputSpan);
        // On timeout close the disposable app-server: no more turns are needed.
        const revisionTimer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => rpc.close(), timeoutMs);
        try {
          await rpc.call("turn/start", {
            threadId,
            ...(job.model && { model: job.model }),
            ...(job.effort && { effort: job.effort }),
            // Revisions may only summarize the existing answer, never edit code.
            sandboxPolicy:
              revision === 0 ? sandboxPolicy : { type: "readOnly" },
            input: [{ type: "text", text: prompt, text_elements: [] }],
            ...(outputSchema && { outputSchema }),
          });
          await completed;
          signal.throwIfAborted();
          if (failure) throw failure;
          if (githubReader && !githubReader.isSourceRead())
            throw new Error(
              "The assigned GitHub issue was not read completely",
            );
          return reply;
        } finally {
          clearTimeout(revisionTimer);
        }
      },
    });
    agentSucceeded = true;
    return result;
  } catch (error) {
    agentError = error;
    throw error;
  } finally {
    if (agentSpan)
      diagnostics?.end(
        agentSpan,
        { outcome: agentSucceeded ? "succeeded" : "failed" },
        agentSucceeded ? undefined : diagnosticErrorBody(agentError),
      );
    signal.removeEventListener("abort", abort);
    rpc.close();
  }
}

export const codexAgent = createCodexAgent();

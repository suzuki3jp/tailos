import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { CodexAccess, type RunnerJob } from "@tailos/core/runner";
import * as v from "valibot";
import type { Diagnostics } from "@tailos/core/diagnostics";
import { AgentSandboxUnavailable, type AgentAdapter } from "@/agent.ts";
import { agentPrompt, replySchema, runAgentTurns } from "@/agent-turns.ts";
import { CodexRpc, type CodexProcess } from "@/codex-rpc.ts";
import { listCodexModels } from "@/codex-models.ts";
import {
  createGitHubReader,
  githubTool,
  githubToolCallSchema,
} from "@/github-tool.ts";

const threadSchema = v.object({
  thread: v.object({ id: v.string() }),
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
const completedSchema = v.object({
  threadId: v.string(),
  turn: v.object({ status: v.string() }),
});

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
    async run(job, signal, cwd, diagnostics) {
      if (job.engine !== "codex") throw new Error("Invalid Codex job");
      const root = await mkdtemp(join(tmpdir(), "tailos-codex-"));
      const directory = join(root, "codex");
      const environment = job.checkout ? join(root, "environment") : undefined;
      try {
        signal.throwIfAborted();
        await mkdir(directory);
        if (environment)
          await Promise.all(
            ["home", "tmp", "runtime", "cache", "tools/bin"].map((path) =>
              mkdir(join(environment, path), { recursive: true, mode: 0o700 }),
            ),
          );
        return await runTurn(
          launch(directory, cwd ?? directory, environment),
          cwd ?? directory,
          job,
          signal,
          http,
          environment,
          diagnostics,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

async function initialize(rpc: CodexRpc) {
  await rpc.call("initialize", {
    clientInfo: { name: "tailos", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized");
}

export function createCodexModelCatalog(launch = launchCodex) {
  return async (access: CodexAccess, signal: AbortSignal) => {
    const directory = await mkdtemp(join(tmpdir(), "tailos-models-"));
    let rpc: CodexRpc | undefined;
    const abort = () => rpc?.close();
    try {
      signal.throwIfAborted();
      rpc = new CodexRpc(launch(directory, directory));
      signal.addEventListener("abort", abort, { once: true });
      await initialize(rpc);
      await rpc.call("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: access.accessToken,
        chatgptAccountId: access.accountId,
        chatgptPlanType: access.planType,
      });
      const models = await listCodexModels(rpc);
      signal.throwIfAborted();
      return models.map((m) => ({
        model: m.model,
        efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
      }));
    } finally {
      signal.removeEventListener("abort", abort);
      rpc?.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export const codexModelCatalog = createCodexModelCatalog();

async function runTurn(
  child: CodexProcess,
  cwd: string,
  job: Extract<RunnerJob, { engine: "codex" }>,
  signal: AbortSignal,
  http: typeof fetch,
  environment?: string,
  diagnostics?: Diagnostics,
) {
  const sandboxPolicy =
    environment && job.mode !== "plan"
      ? {
          type: "workspaceWrite" as const,
          writableRoots: [cwd, environment],
          networkAccess: job.checkout?.agentNetworkAccess === true,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        }
      : { type: "readOnly" as const };
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
  let access = job.access;
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
  const itemSpans = new Map<string, string>();
  const diagnosticItemSchema = v.object({
    threadId: v.string(),
    item: v.object({
      id: v.optional(v.string()),
      type: v.string(),
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
  if (job.checkout) sensitive.add(job.checkout.token);
  const loginParams = () => ({
    accessToken: access.accessToken,
    chatgptAccountId: access.accountId,
    chatgptPlanType: access.planType,
  });

  let resolveTurn = () => {};
  let rejectTurn = (_error: Error) => {};
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    rejectTurn(error);
  };
  rpc.onFailure = fail;
  rpc.onRequest = async (method, params) => {
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

    const url = new URL(job.refresh.url);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid refresh URL");
    const response = await http(url, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${job.refresh.bearer}`,
        "X-Tailos-Access-Version": access.accessVersion,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error("Refresh unavailable");
    const next = v.parse(CodexAccess, await response.json());
    if (
      next.accountId !== access.accountId ||
      next.connectionVersion !== access.connectionVersion
    )
      throw new Error("Connection changed");
    access = next;
    sensitive.add(next.accessToken);
    diagnostics?.addSecret(next.accessToken);
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
        const operation =
          item.type === "commandExecution"
            ? "command"
            : item.type === "fileChange"
              ? "file_change"
              : item.type === "agentMessage"
                ? "reply"
                : item.type === "mcpToolCall" || item.type === "webSearch"
                  ? "tool"
                  : undefined;
        if (operation) {
          const id = item.id ?? "reply";
          let span = itemSpans.get(id);
          if (!span && itemSpans.size < 1000) {
            span = diagnostics.start(
              operation,
              item.command === undefined
                ? undefined
                : JSON.stringify({ command: item.command, cwd: item.cwd }),
              agentSpan,
            );
            itemSpans.set(id, span);
          }
          if (span && method === "item/completed") {
            diagnostics.end(
              span,
              {
                outcome:
                  item.exitCode != null
                    ? item.exitCode === 0
                      ? "succeeded"
                      : "failed"
                    : item.status === "failed"
                      ? "failed"
                      : operation === "reply" || item.status === "completed"
                        ? "succeeded"
                        : "unknown",
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
    if (method === "turn/completed") {
      const turn = v.parse(completedSchema, params);
      if (turn.threadId !== threadId) return;
      if (turn.turn.status === "completed") resolveTurn();
      else fail(new Error("Codex turn failed"));
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
    if (job.model || job.effort) {
      const models = await listCodexModels(rpc);
      const selected = models.find((m) =>
        job.model ? m.model === job.model : m.isDefault,
      );
      if (
        !selected ||
        (job.effort &&
          !selected.supportedReasoningEfforts.some(
            (e) => e.reasoningEffort === job.effort,
          ))
      )
        throw new Error("Requested model or effort is unavailable");
    }
    const thread = v.parse(
      threadSchema,
      await rpc.call("thread/start", {
        cwd,
        ...(job.model && { model: job.model }),
        ephemeral: true,
        approvalPolicy: "never",
        sandbox:
          job.checkout && job.mode !== "plan" ? "workspace-write" : "read-only",
        ...(job.checkout && { dynamicTools: [githubTool] }),
      }),
    );
    threadId = thread.thread.id;
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
      prompt: agentPrompt(job, githubTool.name),
      sensitive,
      failure: () => failure,
      async turn(prompt, revision, timeoutMs) {
        reply = "";
        // Arm a new completion before turn/start: notifications can arrive
        // before the RPC response. Never reuse a previous turn's reply or
        // completion.
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
  } finally {
    if (agentSpan)
      diagnostics?.end(agentSpan, {
        outcome: agentSucceeded ? "succeeded" : "failed",
      });
    signal.removeEventListener("abort", abort);
    rpc.close();
  }
}

export const codexAgent = createCodexAgent();

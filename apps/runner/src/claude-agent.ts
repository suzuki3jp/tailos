import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";
import type {
  HookCallback,
  McpServerConfig,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import type { Diagnostics } from "@tailos/core/diagnostics";
import * as v from "valibot";
import { AgentSandboxUnavailable, type AgentAdapter } from "@/agent.ts";
import {
  agentPrompt,
  replySchema,
  runAgentTurns,
  type RepositoryJob,
} from "@/agent-turns.ts";
import { createGitHubReader, githubTool } from "@/github-tool.ts";

type ClaudeJob = Extract<RepositoryJob, { engine: "claude" }>;
type GitHubRead = ReturnType<typeof createGitHubReader>["read"];

// The part of the Agent SDK the adapter depends on. Tests replace it with a
// fixed message sequence, as the Codex adapter's tests replace its process.
export type ClaudeRuntime = {
  query(params: {
    prompt: string;
    options: Options;
  }): AsyncIterable<unknown> & { close?(): void };
  githubServer(read: GitHubRead): McpServerConfig;
  // Whether the command sandbox can start in this environment.
  sandboxAvailable(signal: AbortSignal): Promise<boolean>;
};

const githubServerName = "tailos";
const githubToolLocalName = "github_get";
// The name Claude Code gives a tool of an SDK MCP server.
const githubToolName = `mcp__${githubServerName}__${githubToolLocalName}`;

// The SDK ships Claude Code as a platform-specific binary, so the image
// installs it next to the bundle and the bundle loads it only for Claude jobs.
export const loadClaudeRuntime = async (): Promise<ClaudeRuntime> => {
  const [sdk, { z }] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("zod"),
  ]);
  return {
    query: sdk.query,
    // Claude Code checks that bubblewrap is installed, not that it can create
    // namespaces here. Without this check every command of the Run would fail.
    sandboxAvailable: (signal) =>
      new Promise((resolve) => {
        execFile(
          "bwrap",
          [
            "--unshare-user",
            "--unshare-pid",
            "--unshare-net",
            "--ro-bind",
            "/",
            "/",
            "/bin/true",
          ],
          { signal, timeout: 5_000 },
          (error) => resolve(!error),
        );
      }),
    githubServer: (read) =>
      sdk.createSdkMcpServer({
        name: githubServerName,
        version: "0.1.0",
        tools: [
          sdk.tool(
            githubToolLocalName,
            githubTool.description,
            {
              kind: z.enum(["issue", "pull_request"]),
              number: z.number().int().min(1),
              bodyOffset: z.number().int().min(0).optional(),
            },
            // The handler runs in the Runner process: the checkout token
            // never reaches Claude Code.
            async (input) => {
              const result = await read(input);
              return {
                content: result.contentItems.map(({ text }) => ({
                  type: "text" as const,
                  text,
                })),
                isError: !result.success,
              };
            },
          ),
        ],
      }),
  };
};

const messageSchema = v.object({
  type: v.string(),
  subtype: v.optional(v.string()),
  session_id: v.optional(v.string()),
  // system/init
  model: v.optional(v.string()),
  claude_code_version: v.optional(v.string()),
  // assistant and user
  message: v.optional(
    v.object({
      content: v.union([
        v.string(),
        v.array(
          v.object({
            type: v.string(),
            text: v.optional(v.string()),
            id: v.optional(v.string()),
            name: v.optional(v.string()),
            input: v.optional(v.unknown()),
            tool_use_id: v.optional(v.string()),
            is_error: v.optional(v.boolean()),
            content: v.optional(v.unknown()),
          }),
        ),
      ]),
    }),
  ),
  // result
  is_error: v.optional(v.boolean()),
  result: v.optional(v.string()),
  structured_output: v.optional(v.unknown()),
  startup_failure_reason: v.optional(v.string()),
  num_turns: v.optional(v.number()),
  duration_ms: v.optional(v.number()),
  total_cost_usd: v.optional(v.number()),
  usage: v.optional(v.unknown()),
  permission_denials: v.optional(v.array(v.object({ tool_name: v.string() }))),
});

const toolInputSchema = v.object({
  command: v.optional(v.string()),
  file_path: v.optional(v.string()),
  notebook_path: v.optional(v.string()),
  path: v.optional(v.string()),
  pattern: v.optional(v.string()),
});

// Resolves symbolic links in the existing part of a path, so a link inside the
// workspace cannot name a file outside it.
async function canonicalPath(path: string) {
  const rest: string[] = [];
  for (let current = path; ;) {
    try {
      return join(await realpath(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

// Claude Code's sandbox confines Bash only. Its file tools run with the
// Runner's own access, so this hook keeps them inside the given directories.
export function createFileGuard(cwd: string, roots: string[]): HookCallback {
  const allowed = Promise.all(roots.map(canonicalPath));
  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });
  return async (hook) => {
    if (hook.hook_event_name !== "PreToolUse") return {};
    const input = v.safeParse(toolInputSchema, hook.tool_input);
    let target: string | undefined;
    switch (hook.tool_name) {
      case "Read":
      case "Edit":
      case "Write":
        target = input.success ? input.output.file_path : undefined;
        break;
      case "NotebookEdit":
        target = input.success ? input.output.notebook_path : undefined;
        break;
      case "Glob":
      case "Grep": {
        if (!input.success) break;
        const pattern = input.output.pattern ?? "";
        if (
          hook.tool_name === "Glob" &&
          (isAbsolute(pattern) || pattern.split(/[\\/]/).includes(".."))
        )
          return deny("Search patterns must stay inside the workspace");
        target = input.output.path ?? cwd;
        break;
      }
      default:
        return {};
    }
    if (target === undefined) return deny("Missing file path");
    const path = await canonicalPath(resolve(cwd, target));
    for (const root of await allowed)
      if (path === root || path.startsWith(root + sep)) return {};
    return deny("File access is limited to the workspace");
  };
}

function recordMessage(
  message: v.InferOutput<typeof messageSchema>,
  diagnostics: Diagnostics,
  agentSpan: string,
  toolSpans: Map<string, string>,
) {
  if (message.type === "system" && message.subtype === "init") {
    diagnostics.output(
      agentSpan,
      JSON.stringify({
        model: message.model,
        version: message.claude_code_version,
      }),
    );
    return;
  }
  if (message.type === "result") {
    diagnostics.output(
      agentSpan,
      JSON.stringify({
        subtype: message.subtype,
        turns: message.num_turns,
        durationMs: message.duration_ms,
        costUsd: message.total_cost_usd,
        usage: message.usage,
        permissionDenials: message.permission_denials?.map(
          (denial) => denial.tool_name,
        ),
      }),
    );
    return;
  }
  const content = message.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (message.type === "assistant" && block.type === "text" && block.text) {
      const span = diagnostics.start("reply", undefined, agentSpan);
      diagnostics.end(
        span,
        { outcome: "succeeded" },
        JSON.stringify({ text: block.text }),
      );
    } else if (
      message.type === "assistant" &&
      block.type === "tool_use" &&
      block.id &&
      // The handler of the Tailos tool records its own call.
      block.name !== githubToolName &&
      toolSpans.size < 1000
    ) {
      const input = v.safeParse(toolInputSchema, block.input);
      const command = input.success ? input.output.command : undefined;
      toolSpans.set(
        block.id,
        block.name === "Bash" && command !== undefined
          ? diagnostics.start("command", JSON.stringify({ command }), agentSpan)
          : diagnostics.start(
              block.name === "Edit" ||
                block.name === "Write" ||
                block.name === "NotebookEdit"
                ? "file_change"
                : "tool",
              JSON.stringify({ tool: block.name, arguments: block.input }),
              agentSpan,
            ),
      );
    } else if (
      message.type === "user" &&
      block.type === "tool_result" &&
      block.tool_use_id
    ) {
      const span = toolSpans.get(block.tool_use_id);
      if (!span) continue;
      toolSpans.delete(block.tool_use_id);
      // Claude Code does not report an exit code for a command.
      diagnostics.end(
        span,
        { outcome: block.is_error ? "failed" : "succeeded" },
        JSON.stringify({ output: block.content }),
      );
    }
  }
}

export function createClaudeAgent(
  load = loadClaudeRuntime,
  http = fetch,
): AgentAdapter {
  return {
    async run(job, signal, cwd, diagnostics) {
      if (job.engine !== "claude") throw new Error("Invalid Claude job");
      const root = await mkdtemp(join(tmpdir(), "tailos-claude-"));
      const environment = join(root, "environment");
      try {
        signal.throwIfAborted();
        await Promise.all(
          ["config", "workspace"]
            .map((path) => join(root, path))
            .concat(
              ["home", "tmp", "runtime", "cache", "tools/bin"].map((path) =>
                join(environment, path),
              ),
            )
            .map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
        );
        return await runTurns(
          await load(),
          cwd ?? join(root, "workspace"),
          join(root, "config"),
          environment,
          job,
          signal,
          http,
          diagnostics,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

async function runTurns(
  runtime: ClaudeRuntime,
  cwd: string,
  configDirectory: string,
  environment: string,
  job: ClaudeJob,
  signal: AbortSignal,
  http: typeof fetch,
  diagnostics?: Diagnostics,
) {
  if (job.githubContext && !job.checkout)
    throw new Error("GitHub issue context requires a repository checkout");
  const implementation = !!job.checkout && job.mode !== "plan";
  const githubReader = job.checkout
    ? createGitHubReader(
        job.checkout,
        signal,
        http,
        job.githubContext?.number,
        job.githubContext?.contentHash,
      )
    : undefined;
  const sensitive = new Set([job.access.token, job.lease.bearer]);
  if (job.checkout) sensitive.add(job.checkout.token);
  const agentSpan = diagnostics?.start(
    "agent",
    JSON.stringify({
      engine: "claude",
      version: process.env.TAILOS_CLAUDE_AGENT_SDK_VERSION ?? "unknown",
      sandbox: implementation ? "workspace-write" : "read-only",
      ...(implementation && { commandNetwork: "blocked" }),
    }),
  );
  const toolSpans = new Map<string, string>();
  const readGitHub: GitHubRead = async (input) => {
    if (!githubReader) throw new Error("GitHub tool requires a checkout");
    const span = diagnostics?.start(
      "tool",
      JSON.stringify({ name: githubToolName, arguments: input }),
      agentSpan,
    );
    try {
      const result = await githubReader.read(input);
      if (span) {
        try {
          const { diagnosticReason, ...recorded } = result;
          diagnostics?.end(
            span,
            {
              outcome: result.success ? "succeeded" : "failed",
              ...(diagnosticReason ? { reason: diagnosticReason } : {}),
            },
            JSON.stringify(recorded),
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
  };

  // Plan mode gets no command execution, so it cannot change the workspace.
  // Skill lets the Agent use the skills of the target repository.
  const tools = implementation
    ? ["Read", "Glob", "Grep", "Skill", "Edit", "Write", "Bash"]
    : ["Read", "Glob", "Grep", "Skill"];
  const outputSchema = replySchema(job);
  // `env` replaces the environment of Claude Code: pass only what it needs.
  const env = {
    PATH: [
      join(environment, "tools", "bin"),
      join(environment, "tools"),
      process.env.PATH,
    ].join(delimiter),
    HOME: join(environment, "home"),
    TMPDIR: join(environment, "tmp"),
    XDG_RUNTIME_DIR: join(environment, "runtime"),
    XDG_CACHE_HOME: join(environment, "cache"),
    PNPM_HOME: join(environment, "tools"),
    npm_config_prefix: join(environment, "tools"),
    npm_config_verify_deps_before_run: "false",
    pnpm_config_verify_deps_before_run: "false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // Holds this Run's conversation only: no user settings exist in it.
    CLAUDE_CONFIG_DIR: configDirectory,
    CLAUDE_CODE_OAUTH_TOKEN: job.access.token,
    // Keep the token out of the commands the Agent runs.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    // Report a known startup failure as a result message, not only on stderr.
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "tailos/0.1.0",
  };
  const fileGuard = createFileGuard(cwd, [cwd, environment]);
  let sessionId: string | undefined;
  let agentSucceeded = false;
  try {
    if (implementation && !(await runtime.sandboxAvailable(signal))) {
      signal.throwIfAborted();
      throw new AgentSandboxUnavailable(
        "Claude Code command sandbox unavailable",
      );
    }
    const result = await runAgentTurns({
      job,
      signal,
      prompt: agentPrompt(job, githubToolName),
      sensitive,
      async turn(prompt, revision, timeoutMs) {
        const first = revision === 0;
        if (!first && !sessionId)
          throw new Error("Claude Code session is unavailable");
        const inputSpan = diagnostics?.start("input", prompt, agentSpan);
        if (inputSpan) diagnostics?.end(inputSpan);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        // On timeout stop Claude Code: no more turns are needed.
        const revisionTimer =
          timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
        const stream = runtime.query({
          prompt,
          options: {
            cwd,
            env,
            abortController: controller,
            systemPrompt: { type: "preset", preset: "claude_code" },
            // The target repository's CLAUDE.md, skills, settings and hooks.
            settingSources: ["project"],
            // Not the repository's .mcp.json servers.
            strictMcpConfig: true,
            permissionMode: "dontAsk",
            ...(outputSchema && {
              outputFormat: { type: "json_schema", schema: outputSchema },
            }),
            ...(first
              ? {
                  tools,
                  allowedTools: githubReader
                    ? [...tools, githubToolName]
                    : tools,
                  skills: "all",
                  mcpServers: githubReader
                    ? { [githubServerName]: runtime.githubServer(readGitHub) }
                    : {},
                  hooks: { PreToolUse: [{ hooks: [fileGuard] }] },
                  ...(implementation && {
                    sandbox: {
                      enabled: true,
                      // Never run a command outside the sandbox.
                      failIfUnavailable: true,
                      allowUnsandboxedCommands: false,
                      autoAllowBashIfSandboxed: true,
                      filesystem: { allowWrite: [cwd, environment] },
                      // What agentNetworkAccess allows Claude Code is undecided,
                      // so commands get no network whatever its value. The
                      // strict list also ignores the repository's own
                      // allowed domains.
                      network: { allowedDomains: [], strictAllowlist: true },
                    },
                  }),
                }
              : // Revisions may only summarize the existing answer.
                { resume: sessionId, tools: [], skills: [], mcpServers: {} }),
          },
        });
        let outcome: v.InferOutput<typeof messageSchema> | undefined;
        try {
          for await (const raw of stream) {
            const parsed = v.safeParse(messageSchema, raw);
            if (!parsed.success) continue;
            const message = parsed.output;
            if (message.type === "result") outcome = message;
            if (diagnostics && agentSpan) {
              try {
                recordMessage(message, diagnostics, agentSpan, toolSpans);
              } catch {
                // Recording diagnostics must not change the turn.
              }
            }
          }
        } finally {
          clearTimeout(revisionTimer);
          signal.removeEventListener("abort", abort);
          stream.close?.();
        }
        signal.throwIfAborted();
        if (!outcome) throw new Error("Claude Code ended without a result");
        if (outcome.startup_failure_reason === "sandbox_required_unavailable")
          throw new AgentSandboxUnavailable(
            "Claude Code command sandbox unavailable",
          );
        if (outcome.subtype !== "success" || outcome.is_error)
          throw new Error("Claude Code turn failed");
        sessionId = outcome.session_id ?? sessionId;
        if (githubReader && !githubReader.isSourceRead())
          throw new Error("The assigned GitHub issue was not read completely");
        if (!outputSchema) {
          if (outcome.result === undefined)
            throw new Error("Claude Code returned no answer");
          return outcome.result;
        }
        if (outcome.structured_output === undefined)
          throw new Error("Claude Code returned no structured answer");
        return JSON.stringify(outcome.structured_output);
      },
    });
    agentSucceeded = true;
    return result;
  } finally {
    if (agentSpan)
      diagnostics?.end(agentSpan, {
        outcome: agentSucceeded ? "succeeded" : "failed",
      });
  }
}

export const claudeAgent = createClaudeAgent();

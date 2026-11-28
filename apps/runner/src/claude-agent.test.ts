import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createSdkMcpServer,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import type { Diagnostics } from "@tailos/core/diagnostics";
import { maxReplyLength, type RunnerJob } from "@tailos/core/runner";
import { expect, test, vi, type TestContext } from "vitest";
import { AgentSandboxUnavailable } from "@/agent.ts";
import {
  createClaudeAgent,
  createFileGuard,
  loadClaudeRuntime,
  type ClaudeRuntime,
} from "@/claude-agent.ts";

type ClaudeJob = Extract<RunnerJob, { engine: "claude" }>;
type Call = { prompt: string; options: Options };
type TailosTools = Parameters<ClaudeRuntime["tailosServer"]>[0];
type GitHubRead = NonNullable<TailosTools["read"]>;

const token = "claude-oauth-token";
const checkout = {
  repository: "acme/widgets",
  baseSha: "a".repeat(40),
  defaultBranch: "main",
  author: {
    name: "tailos-app[bot]",
    email: "1+tailos-app[bot]@users.noreply.github.com",
  },
};
const job = (overrides: Partial<ClaudeJob> = {}): ClaudeJob => ({
  version: 1,
  engine: "claude",
  runId: randomUUID(),
  prompt: "Fix the bug",
  deadlineAt: Date.now() + 600_000,
  access: { token, connectionVersion: randomUUID() },
  ...overrides,
});
const success = (structured: unknown, sessionId = "session-1") => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: sessionId,
  result: typeof structured === "string" ? structured : "",
  ...(typeof structured === "string" ? {} : { structured_output: structured }),
  num_turns: 1,
  duration_ms: 10,
  total_cost_usd: 0.01,
  permission_denials: [{ tool_name: "WebFetch" }],
});

// Replays one fixed message sequence per turn and records what was asked.
function runtime(
  turns: Array<
    unknown[] | ((call: Call, read?: GitHubRead) => Promise<unknown[]>)
  >,
  sandboxAvailable = true,
) {
  const calls: Call[] = [];
  const proxies = { started: 0, closed: 0 };
  let read: GitHubRead | undefined;
  const fake: ClaudeRuntime = {
    async startProxy() {
      proxies.started++;
      return {
        port: 41_000,
        close: async () => {
          proxies.closed++;
        },
      };
    },
    query(call) {
      calls.push(call);
      const turn = turns[calls.length - 1];
      return (async function* () {
        if (!turn) throw new Error("Unexpected turn");
        yield* typeof turn === "function" ? await turn(call, read) : turn;
      })();
    },
    sandboxAvailable: async () => sandboxAvailable,
    tailosServer(tools) {
      read = tools.read;
      return createSdkMcpServer({ name: "tailos" });
    },
  };
  return {
    calls,
    proxies,
    agent: (http = fetch) => createClaudeAgent(async () => fake, http),
  };
}

async function workspace(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "tailos-claude-test-")),
  );
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function recorder() {
  const spans: Array<{
    operation: string;
    body?: string;
    outcome?: string;
    result?: string;
  }> = [];
  const outputs: string[] = [];
  const diagnostics: Diagnostics = {
    start(operation, body) {
      spans.push({ operation, body });
      return String(spans.length - 1);
    },
    end(spanId, attributes, body) {
      const span = spans[Number(spanId)]!;
      span.outcome = attributes?.outcome;
      span.result = body;
    },
    output: (_spanId, body) => void outputs.push(body),
    addSecret() {},
  };
  return { spans, outputs, diagnostics };
}

test("runs an implementation turn inside the workspace with only the Run's credentials", async (t) => {
  const cwd = await workspace(t);
  const { calls, agent } = runtime([
    [
      { type: "system", subtype: "init", model: "claude-test" },
      success({
        reply: "Done",
        headline: "fix: repair the widget",
        sessionTitle: "Widget repair",
      }),
    ],
  ]);

  const result = await agent().run(
    job({ checkout }),
    new AbortController().signal,
    cwd,
  );

  expect(result).toEqual({ reply: "Done", sessionTitle: "Widget repair" });
  const { prompt, options } = calls[0]!;
  expect(prompt).toContain("Fix the bug");
  expect(prompt).toContain("Use mcp__tailos__github_get to look up");
  expect(options).toMatchObject({
    cwd,
    settingSources: ["project"],
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    tools: ["Read", "Glob", "Grep", "Skill", "Edit", "Write", "Bash"],
    allowedTools: [
      "Read",
      "Glob",
      "Grep",
      "Skill",
      "Edit",
      "Write",
      "Bash",
      "mcp__tailos__github_get",
    ],
    skills: "all",
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: {
        httpProxyPort: 41_000,
        allowedDomains: [],
        strictAllowlist: true,
      },
    },
    outputFormat: { type: "json_schema" },
  });
  expect(options.sandbox?.filesystem?.allowWrite?.[0]).toBe(cwd);
  expect(options.resume).toBeUndefined();
  const env = options.env!;
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
  expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  expect(env.CLAUDE_CONFIG_DIR).not.toContain(cwd);
  // Nothing of the Runner's own environment leaks in.
  expect(
    Object.keys(env).filter((name) => /TAILOS|ANTHROPIC/.test(name)),
  ).toEqual([]);
  await expect(stat(env.CLAUDE_CONFIG_DIR!)).rejects.toThrow();
});

test("commands reach the internet only through the Runner's proxy, stopped after the Run", async (t) => {
  const cwd = await workspace(t);
  const { calls, proxies, agent } = runtime([
    [success({ reply: "Done", headline: null })],
  ]);
  const { diagnostics, spans } = recorder();

  await agent().run(
    job({ checkout }),
    new AbortController().signal,
    cwd,
    diagnostics,
  );

  expect(calls[0]!.options.sandbox?.network).toEqual({
    httpProxyPort: 41_000,
    allowedDomains: [],
    strictAllowlist: true,
  });
  expect(proxies).toEqual({ started: 1, closed: 1 });
  expect(JSON.parse(spans[0]!.body!)).toMatchObject({
    commandNetwork: "proxied",
  });
});

test("gives a planning turn no tool that can change the workspace", async (t) => {
  const cwd = await workspace(t);
  const { calls, agent } = runtime([
    [success({ reply: "Plan", planPresented: true, needsAnswer: false })],
  ]);

  const result = await agent().run(
    job({ checkout, mode: "plan" }),
    new AbortController().signal,
    cwd,
  );

  expect(result).toEqual({
    reply: "Plan",
    plan: { planPresented: true, needsAnswer: false },
  });
  const { options } = calls[0]!;
  expect(options.tools).toEqual(["Read", "Glob", "Grep", "Skill"]);
  expect(options.allowedTools).toEqual([
    "Read",
    "Glob",
    "Grep",
    "Skill",
    "mcp__tailos__github_get",
  ]);
  expect(options.sandbox).toBeUndefined();
});

test("serves the GitHub tool from the Runner and requires the assigned issue to be read", async (t) => {
  const cwd = await workspace(t);
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({
      number: 7,
      title: "Broken widget",
      body: "Details",
      state: "open",
      html_url: "https://github.com/acme/widgets/issues/7",
    }),
  );
  const reply = [success({ reply: "Done", headline: null })];
  const withIssue = job({
    checkout,
    githubContext: { kind: "issue", number: 7 },
  });

  const unread = runtime([reply]);
  await expect(
    unread.agent(http).run(withIssue, new AbortController().signal, cwd),
  ).rejects.toThrow("not read completely");

  const { diagnostics, spans } = recorder();
  const read = runtime([
    async (_call, tool) => {
      const result = await tool!({ kind: "issue", number: 7 });
      expect(result.success).toBe(true);
      expect(result.contentItems[0]!.text).toContain("Broken widget");
      return reply;
    },
  ]);
  await read
    .agent(http)
    .run(withIssue, new AbortController().signal, cwd, diagnostics);

  expect(read.calls[0]!.prompt).toContain(
    "call mcp__tailos__github_get for this issue",
  );
  expect(read.calls[0]!.options.mcpServers).toHaveProperty("tailos");
  const [url, init] = http.mock.calls[0]!;
  expect(String(url)).toBe(
    "https://api.github.com/repos/acme/widgets/issues/7",
  );
  // The Run's token is added outside the container.
  expect(new Headers(init?.headers).get("Authorization")).toBeNull();
  expect(spans.find((span) => span.operation === "tool")).toMatchObject({
    body: JSON.stringify({
      name: "mcp__tailos__github_get",
      arguments: { kind: "issue", number: 7 },
    }),
    outcome: "succeeded",
  });
});

test("records commands, file changes, tools and replies without an exit code", async (t) => {
  const cwd = await workspace(t);
  const { diagnostics, spans, outputs } = recorder();
  const use = (id: string, name: string, input: unknown) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const done = (id: string, content: string, isError = false) => ({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, is_error: isError, content },
      ],
    },
  });
  const { agent } = runtime([
    [
      { type: "system", subtype: "init", model: "claude-test" },
      { type: "stream_event", event: {} },
      use("1", "Bash", { command: "pnpm test" }),
      done("1", "1 failed", true),
      use("2", "Edit", { file_path: join(cwd, "a.ts") }),
      done("2", "ok"),
      use("3", "Grep", { pattern: "widget" }),
      done("3", "a.ts"),
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hi" }] },
      },
      success({ reply: "Done", headline: null }),
    ],
  ]);

  await agent().run(
    job({ checkout }),
    new AbortController().signal,
    cwd,
    diagnostics,
  );

  expect(spans.map(({ operation, outcome }) => [operation, outcome])).toEqual([
    ["agent", "succeeded"],
    ["input", undefined],
    ["command", "failed"],
    ["file_change", "succeeded"],
    ["tool", "succeeded"],
    ["reply", "succeeded"],
    ["cleanup", "succeeded"],
  ]);
  expect(spans[2]).toMatchObject({
    body: JSON.stringify({ command: "pnpm test" }),
    result: JSON.stringify({ output: "1 failed" }),
  });
  expect(JSON.parse(spans[0]!.body!)).toMatchObject({
    engine: "claude",
    sandbox: "workspace-write",
  });
  expect(outputs.map((body) => JSON.parse(body))).toMatchObject([
    { model: "claude-test" },
    { subtype: "success", costUsd: 0.01, permissionDenials: ["WebFetch"] },
  ]);
});

test("reports an unavailable command sandbox instead of running without it", async (t) => {
  const cwd = await workspace(t);
  const reported = runtime([
    [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        startup_failure_reason: "sandbox_required_unavailable",
      },
    ],
  ]);
  await expect(
    reported.agent().run(job({ checkout }), new AbortController().signal, cwd),
  ).rejects.toBeInstanceOf(AgentSandboxUnavailable);

  // Claude Code does not notice a sandbox that is installed but cannot start.
  const blocked = runtime([], false);
  await expect(
    blocked.agent().run(job({ checkout }), new AbortController().signal, cwd),
  ).rejects.toBeInstanceOf(AgentSandboxUnavailable);
  expect(blocked.calls).toEqual([]);

  // Planning runs no command, so it does not depend on the sandbox.
  const planning = runtime(
    [[success({ reply: "Plan", planPresented: true, needsAnswer: false })]],
    false,
  );
  await expect(
    planning
      .agent()
      .run(job({ checkout, mode: "plan" }), new AbortController().signal, cwd),
  ).resolves.toMatchObject({ reply: "Plan" });
});

test.each([
  [
    "an error result",
    [{ type: "result", subtype: "error_max_turns", is_error: true }],
  ],
  [
    "a failed successful result",
    [{ ...success({ reply: "x", headline: null }), is_error: true }],
  ],
  ["no result", [{ type: "system", subtype: "init" }]],
  ["no structured answer", [success("plain text")]],
  ["an answer of the wrong shape", [success({ reply: 1, headline: null })]],
])("fails the Run on %s", async (_name, messages) => {
  const cwd = await mkdtemp(join(tmpdir(), "tailos-claude-test-"));
  try {
    const { agent } = runtime([messages]);
    const { diagnostics, spans } = recorder();
    await expect(
      agent().run(
        job({ checkout }),
        new AbortController().signal,
        cwd,
        diagnostics,
      ),
    ).rejects.toThrow();
    expect(spans[0]).toMatchObject({ operation: "agent", outcome: "failed" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("returns plain text when the job has no repository", async () => {
  const { calls, agent } = runtime([[success("Hello")]]);

  await expect(
    agent().run(job(), new AbortController().signal),
  ).resolves.toEqual({ reply: "Hello" });
  expect(calls[0]!.options.outputFormat).toBeUndefined();
  expect(calls[0]!.options.tools).toEqual(["Read", "Glob", "Grep", "Skill"]);
  expect(calls[0]!.options.mcpServers).toEqual({});
});

test("asks the same session to shorten an oversized answer without tools", async (t) => {
  const cwd = await workspace(t);
  const { calls, agent } = runtime([
    [
      success(
        { reply: `${token} ${"x".repeat(maxReplyLength)}`, headline: "fix: a" },
        "session-9",
      ),
    ],
    [success({ reply: `Short ${token}`, headline: "fix: b" }, "session-9")],
  ]);

  const result = await agent().run(
    job({ checkout }),
    new AbortController().signal,
    cwd,
  );

  // Secrets never reach the reply.
  expect(result).toEqual({ reply: "Short [REDACTED]" });
  expect(calls[1]!.prompt).toContain("Rewrite only the previous answer");
  expect(calls[1]!.options).toMatchObject({
    resume: "session-9",
    tools: [],
    skills: [],
    mcpServers: {},
    permissionMode: "dontAsk",
  });
  expect(calls[1]!.options.sandbox).toBeUndefined();
  expect(calls[1]!.options.allowedTools).toBeUndefined();
});

test("keeps completed implementation work when the shortened answer fails", async (t) => {
  const cwd = await workspace(t);
  const { agent } = runtime([
    [success({ reply: "x".repeat(maxReplyLength + 1), headline: "fix: a" })],
    [{ type: "result", subtype: "error_during_execution", is_error: true }],
  ]);

  const result = await agent().run(
    job({ checkout }),
    new AbortController().signal,
    cwd,
  );

  expect(result.reply).toContain("要約を取得できませんでした");
});

test("stops Claude Code and removes its directories when the Run is aborted", async (t) => {
  const cwd = await workspace(t);
  const controller = new AbortController();
  let configDirectory: string | undefined;
  let stopped: AbortSignal | undefined;
  const { agent } = runtime([
    async ({ options }) => {
      configDirectory = options.env!.CLAUDE_CONFIG_DIR;
      stopped = options.abortController!.signal;
      await stat(configDirectory!);
      controller.abort(new Error("deadline"));
      return [success({ reply: "late", headline: null })];
    },
  ]);

  await expect(
    agent().run(job({ checkout }), controller.signal, cwd),
  ).rejects.toThrow("deadline");
  expect(stopped?.aborted).toBe(true);
  await expect(stat(configDirectory!)).rejects.toThrow();
});

test("keeps file tools inside the workspace", async (t) => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  await symlink(outside, join(cwd, "escape"));
  const guard = createFileGuard(cwd, [cwd]);
  const decide = async (tool_name: string, tool_input: unknown) => {
    const output = await guard(
      {
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input,
        tool_use_id: "1",
        session_id: "s",
        transcript_path: "",
        cwd,
      },
      "1",
      { signal: new AbortController().signal },
    );
    return "hookSpecificOutput" in output &&
      output.hookSpecificOutput?.hookEventName === "PreToolUse"
      ? output.hookSpecificOutput.permissionDecision
      : "allow";
  };

  expect(await decide("Read", { file_path: join(cwd, "a.ts") })).toBe("allow");
  expect(await decide("Write", { file_path: "new/dir/a.ts" })).toBe("allow");
  expect(await decide("Grep", { pattern: "x" })).toBe("allow");
  expect(await decide("Bash", { command: "cat /etc/passwd" })).toBe("allow");
  expect(await decide("Read", { file_path: "/etc/passwd" })).toBe("deny");
  expect(await decide("Read", { file_path: "../secret" })).toBe("deny");
  expect(await decide("Read", { file_path: `${cwd}-sibling/a` })).toBe("deny");
  expect(await decide("Edit", { file_path: "escape/a.ts" })).toBe("deny");
  expect(await decide("Write", { file_path: "escape/new/a.ts" })).toBe("deny");
  expect(await decide("NotebookEdit", { notebook_path: "/tmp/a.ipynb" })).toBe(
    "deny",
  );
  expect(await decide("Grep", { pattern: "x", path: outside })).toBe("deny");
  expect(await decide("Glob", { pattern: "/etc/**" })).toBe("deny");
  expect(await decide("Glob", { pattern: "../**" })).toBe("deny");
  expect(await decide("Read", {})).toBe("deny");
  expect(await decide("Read", "not an object")).toBe("deny");
});

test("builds the Tailos tool server with the installed Agent SDK", async () => {
  const read = vi.fn<GitHubRead>();
  const server = (await loadClaudeRuntime()).tailosServer({ read });

  expect(server).toMatchObject({ type: "sdk", name: "tailos" });
});

const sessionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const transcript = `projects/-work-repo/${sessionId}.jsonl`;

// Writes the transcript where Claude Code keeps it, as Claude Code does.
async function keepTranscript(call: Call, id: string, content: string) {
  const path = join(
    call.options.env!.CLAUDE_CONFIG_DIR!,
    `projects/-work-repo/${id}.jsonl`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

test("lets an implementation write its git directory, and offers no publication tool", async (t) => {
  const cwd = await workspace(t);
  const gitDir = join(cwd, "..", "git");
  const { calls, agent } = runtime([[success({ reply: "Done" })]]);

  await agent().run(
    job({ checkout }),
    new AbortController().signal,
    cwd,
    undefined,
    undefined,
    gitDir,
  );

  const { prompt, options } = calls[0]!;
  expect(options.sandbox?.filesystem?.allowWrite).toContain(gitDir);
  expect(options.allowedTools).not.toContain("mcp__tailos__publish");
  expect(prompt).toContain("git and gh are signed in");
  expect(prompt).not.toContain("publish");
});

test("keeps the conversation for the next Turn and resumes it there", async (t) => {
  const cwd = await workspace(t);
  const save = vi.fn();
  const first = runtime([
    async (call) => {
      await keepTranscript(call, sessionId, "first turn\n");
      return [
        { type: "system", subtype: "init", session_id: sessionId },
        success({ reply: "Started" }, sessionId),
      ];
    },
  ]);
  await first
    .agent()
    .run(job({ checkout }), new AbortController().signal, cwd, undefined, {
      save,
    });
  expect(save).toHaveBeenCalledOnce();
  const [saved] = save.mock.calls[0]!;
  expect(saved).toMatchObject({ threadId: sessionId, path: transcript });
  expect(saved.content.toString()).toBe("first turn\n");

  let restored: string | undefined;
  const next = runtime([
    async (call) => {
      restored = await readFile(
        join(call.options.env!.CLAUDE_CONFIG_DIR!, transcript),
        "utf8",
      );
      await keepTranscript(call, sessionId, "first turn\nsecond turn\n");
      return [success({ reply: "Continued" }, sessionId)];
    },
  ]);
  const resave = vi.fn();
  await next
    .agent()
    .run(job({ checkout }), new AbortController().signal, cwd, undefined, {
      resume: saved,
      save: resave,
    });
  expect(restored).toBe("first turn\n");
  expect(next.calls[0]!.options.resume).toBe(sessionId);
  expect(next.calls[0]!.prompt).not.toContain("could not be restored");
  expect(resave.mock.calls[0]![0].content.toString()).toBe(
    "first turn\nsecond turn\n",
  );
});

test("starts a new conversation and says so when the transcript cannot be resumed", async (t) => {
  const cwd = await workspace(t);
  const { calls, agent } = runtime([
    [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: sessionId,
        errors: [`No conversation found with session ID: ${sessionId}`],
      },
    ],
    [success({ reply: "Fresh" }, "1b4e28ba-2fa1-41d2-883f-0016d3cca427")],
  ]);

  const result = await agent().run(
    job({ checkout }),
    new AbortController().signal,
    cwd,
    undefined,
    {
      resume: {
        threadId: sessionId,
        path: transcript,
        content: Buffer.from("broken"),
      },
      save: () => {},
    },
  );

  expect(result.reply).toBe("Fresh");
  expect(calls[0]!.options.resume).toBe(sessionId);
  expect(calls[1]!.options.resume).toBeUndefined();
  expect(calls[1]!.prompt).toMatch(
    /^Note: the conversation from this Session's previous turn could not be restored, but the work tree is as the previous turn left it/,
  );
});

test.for([
  {
    name: "another Model Provider's conversation",
    path: "sessions/2026/11/24/rollout-2026-11-24T00-00-00-thread.jsonl",
  },
  { name: "a path outside its sessions", path: "../settings.json" },
])("does not restore $name", async ({ path }, t) => {
  const cwd = await workspace(t);
  const { calls, agent } = runtime([[success({ reply: "Fresh" })]]);

  await agent().run(
    job({ checkout }),
    new AbortController().signal,
    cwd,
    undefined,
    {
      resume: { threadId: sessionId, path, content: Buffer.from("{}") },
      save: () => {},
    },
  );

  expect(calls[0]!.options.resume).toBeUndefined();
  expect(calls[0]!.prompt).toMatch(
    /^Note: the conversation from this Session's previous turn could not be restored/,
  );
});

test("tells the Agent when the previous work is lost", async (t) => {
  const cwd = await workspace(t);
  const lost = runtime([[success({ reply: "Done" })]]);
  await lost
    .agent()
    .run(job({ checkout }), new AbortController().signal, cwd, undefined, {
      lost: true,
      save: () => {},
    });
  expect(lost.calls[0]!.prompt).toMatch(
    /^Note: the work tree and conversation from this Session's previous turn could not be restored\./,
  );
});

test("runs the chosen model and effort, and refuses ones Claude does not offer", async (t) => {
  const cwd = await workspace(t);
  const { calls, agent } = runtime([[success({ reply: "Done" })]]);

  await agent().run(
    job({ checkout, model: "claude-opus-5-5", effort: "xhigh" }),
    new AbortController().signal,
    cwd,
  );
  expect(calls[0]!.options).toMatchObject({
    model: "claude-opus-5-5",
    effort: "xhigh",
  });

  await expect(
    agent().run(
      job({ checkout, model: "gpt-5.5" }),
      new AbortController().signal,
      cwd,
    ),
  ).rejects.toThrow("Requested model or effort is unavailable");
});

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAccessSchema, type RunnerJob } from "@tailos/core/runner";
import * as v from "valibot";
import { AgentSandboxUnavailable, type AgentAdapter } from "./agent.ts";
import { CodexRpc, type CodexProcess } from "./codex-rpc.ts";

const threadSchema = v.object({ thread: v.object({ id: v.string() }) });
const sandboxProbeSchema = v.object({
  exitCode: v.pipe(v.number(), v.safeInteger()),
});
const messageSchema = v.object({
  threadId: v.string(),
  item: v.object({ type: v.literal("agentMessage"), text: v.string() }),
});
const completedSchema = v.object({
  threadId: v.string(),
  turn: v.object({ status: v.string() }),
});

type LaunchCodex = (directory: string, workspace: string) => CodexProcess;
const launchCodex: LaunchCodex = (directory, workspace) =>
  spawn(
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
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );

export function createCodexAgent(
  launch = launchCodex,
  http = fetch,
): AgentAdapter {
  return {
    async run(job, signal, cwd) {
      if (job.engine !== "codex") throw new Error("Invalid Codex job");
      const directory = await mkdtemp(join(tmpdir(), "tailos-codex-"));
      try {
        signal.throwIfAborted();
        return await runTurn(
          launch(directory, cwd ?? directory),
          cwd ?? directory,
          job,
          signal,
          http,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
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

const repositoryReplySchema = v.object({
  reply: v.string(),
  headline: v.nullable(v.string()),
});

async function runTurn(
  child: CodexProcess,
  cwd: string,
  job: Extract<RunnerJob, { engine: "codex" }>,
  signal: AbortSignal,
  http: typeof fetch,
) {
  const rpc = new CodexRpc(child);
  const abort = () => rpc.close();
  signal.addEventListener("abort", abort, { once: true });
  let access = job.access;
  let threadId: string | undefined;
  let reply = "";
  const sensitive = new Set([access.accessToken, job.refresh.bearer]);
  if (job.checkout) sensitive.add(job.checkout.token);
  const loginParams = () => ({
    accessToken: access.accessToken,
    chatgptAccountId: access.accountId,
    chatgptPlanType: access.planType,
  });

  const completed = new Promise<void>((resolve, reject) => {
    rpc.onFailure = reject;
    rpc.onRequest = async (method) => {
      if (method !== "account/chatgptAuthTokens/refresh")
        throw new Error("Interactive requests are disabled");

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
      const next = v.parse(codexAccessSchema, await response.json());
      if (
        next.accountId !== access.accountId ||
        next.connectionVersion !== access.connectionVersion
      )
        throw new Error("Connection changed");
      access = next;
      sensitive.add(next.accessToken);
      return loginParams();
    };
    rpc.onNotification = (method, params) => {
      if (method === "item/completed") {
        const item = v.safeParse(messageSchema, params);
        if (item.success && item.output.threadId === threadId)
          reply = item.output.item.text;
      }
      if (method === "turn/completed") {
        const turn = v.parse(completedSchema, params);
        if (turn.threadId !== threadId) return;
        if (turn.turn.status === "completed") resolve();
        else reject(new Error("Codex turn failed"));
      }
    };
  });
  void completed.catch(() => {});

  try {
    signal.throwIfAborted();
    await initialize(rpc);
    const probe = v.parse(
      sandboxProbeSchema,
      await rpc.call("command/exec", {
        command: ["/bin/true"],
        cwd,
        timeoutMs: 5_000,
        sandboxPolicy: job.checkout
          ? {
              type: "workspaceWrite",
              excludeSlashTmp: true,
              excludeTmpdirEnvVar: true,
            }
          : { type: "readOnly" },
      }),
    );
    if (probe.exitCode !== 0) {
      throw new AgentSandboxUnavailable("Codex command sandbox unavailable");
    }
    await rpc.call("account/login/start", {
      type: "chatgptAuthTokens",
      ...loginParams(),
    });
    const thread = v.parse(
      threadSchema,
      await rpc.call("thread/start", {
        cwd,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: job.checkout ? "workspace-write" : "read-only",
      }),
    );
    threadId = thread.thread.id;
    await rpc.call("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: job.checkout
            ? job.prompt +
              "\n\nUse the repository instructions and CI configuration to choose and run the applicable formatting, linting, and other verification commands in the workspace. " +
              "Fix failures caused by your changes and rerun the affected checks on the final changes. " +
              "In reply, summarize your work, the commands you ran and their results, and explain any applicable checks you could not run. " +
              "Give an English Conventional Commits headline of at most 100 characters describing the final diff. Use a null headline if you made no changes."
            : job.prompt,
          text_elements: [],
        },
      ],
      ...(job.checkout && {
        outputSchema: {
          type: "object",
          properties: {
            reply: { type: "string" },
            headline: { type: ["string", "null"] },
          },
          required: ["reply", "headline"],
          additionalProperties: false,
        },
      }),
    });
    await completed;

    const redact = (text: string) => {
      for (const secret of sensitive)
        text = text.replaceAll(secret, "[REDACTED]");
      return text;
    };
    if (!job.checkout) return { reply: redact(reply).slice(0, 8000) };
    const result = v.parse(repositoryReplySchema, JSON.parse(reply));
    return {
      reply: redact(result.reply).slice(0, 8000),
      ...(result.headline !== null &&
      redact(result.headline) === result.headline
        ? { headline: result.headline }
        : {}),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    rpc.close();
  }
}

export const codexAgent = createCodexAgent();

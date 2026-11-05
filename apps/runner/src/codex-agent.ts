import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAccessSchema, type RunnerJob } from "@meguri/core/runner";
import * as v from "valibot";
import type { AgentAdapter } from "./agent.ts";
import { CodexRpc, type CodexProcess } from "./codex-rpc.ts";

const threadSchema = v.object({ thread: v.object({ id: v.string() }) });
const messageSchema = v.object({
  threadId: v.string(),
  item: v.object({ type: v.literal("agentMessage"), text: v.string() }),
});
const completedSchema = v.object({
  threadId: v.string(),
  turn: v.object({ status: v.string() }),
});

type LaunchCodex = (directory: string) => CodexProcess;
const launchCodex: LaunchCodex = (directory) =>
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
    ],
    {
      cwd: directory,
      detached: true,
      env: { PATH: process.env.PATH, CODEX_HOME: directory },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );

export function createCodexAgent(
  launch = launchCodex,
  http = fetch,
): AgentAdapter {
  return {
    async run(job, signal) {
      if (job.engine !== "codex") throw new Error("Invalid Codex job");
      const directory = await mkdtemp(join(tmpdir(), "meguri-codex-"));
      try {
        signal.throwIfAborted();
        return await runTurn(launch(directory), directory, job, signal, http);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

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
          "X-Meguri-Access-Version": access.accessVersion,
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
    await rpc.call("initialize", {
      clientInfo: { name: "meguri", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
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
        sandbox: "read-only",
      }),
    );
    threadId = thread.thread.id;
    await rpc.call("turn/start", {
      threadId,
      input: [{ type: "text", text: job.prompt, text_elements: [] }],
    });
    await completed;

    for (const secret of sensitive)
      reply = reply.replaceAll(secret, "[REDACTED]");
    return reply.slice(0, 8000);
  } finally {
    signal.removeEventListener("abort", abort);
    rpc.close();
  }
}

export const codexAgent = createCodexAgent();

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { RunnerJob } from "@tailos/core/runner";
import { ValiError } from "valibot";
import { AgentSandboxUnavailable } from "./agent.ts";
import { createCodexAgent } from "./codex-agent.ts";

const script = `
  const { createInterface } = require("node:readline");
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
  const [workspace, mode, probeJson] = process.argv.slice(1);
  const probeResponse = JSON.parse(probeJson);
  let sandboxReady = false;
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const reply = (result) => send({ id: request.id, result });
    if (request.method === "initialize") reply({});
    if (request.method === "command/exec") {
      const { command, cwd, sandboxPolicy } = request.params;
      if (
        command.join(" ") !== "/bin/true" || cwd !== workspace ||
        sandboxPolicy.type !== mode ||
        (mode === "workspaceWrite" && (
          sandboxPolicy.excludeSlashTmp !== true || sandboxPolicy.excludeTmpdirEnvVar !== true
        ))
      ) throw new Error("Unexpected sandbox probe");
      sandboxReady = probeResponse.result?.exitCode === 0;
      send({ id: request.id, ...probeResponse });
    }
    if (request.method === "account/login/start") {
      if (
        !sandboxReady ||
        request.params.type !== "chatgptAuthTokens" ||
        request.params.accessToken !== "old-access" ||
        request.params.refreshToken !== undefined
      ) throw new Error("Unexpected ChatGPT login payload");
      reply({});
    }
    if (request.method === "thread/start") {
      if (request.params.ephemeral !== true) throw new Error("Expected an ephemeral thread");
      reply({ thread: { id: "test-thread" } });
    }
    if (request.method === "turn/start") {
      const { input, outputSchema } = request.params;
      if (mode === "workspaceWrite") {
        if (!input[0].text.includes("Conventional Commits") || !outputSchema.required.includes("headline"))
          throw new Error("Missing repository response schema");
      } else if (input[0].text !== "Answer the prompt" || outputSchema !== undefined) {
        throw new Error("Unexpected turn input");
      }
      reply({});
      send({ id: "refresh", method: "account/chatgptAuthTokens/refresh", params: {} });
    }
    if (request.id === "refresh") {
      if (
        request.result.accessToken !== "new-access" ||
        request.result.chatgptAccountId !== "account-id"
      ) throw new Error("Unexpected credential refresh response");
      send({ method: "item/completed", params: {
        threadId: "test-thread",
        item: { type: "agentMessage", text: mode === "workspaceWrite"
          ? JSON.stringify({ reply: "Reply containing new-access", headline: "fix(api): handle refresh" })
          : "Reply containing new-access" },
      } });
      send({ method: "turn/completed", params: {
        threadId: "test-thread",
        turn: { status: "completed" },
      } });
    }
  });
`;

function testJob(): Extract<RunnerJob, { engine: "codex" }> {
  return {
    version: 1,
    engine: "codex",
    runId: randomUUID(),
    deadlineAt: Date.now() + 15_000,
    prompt: "Answer the prompt",
    access: {
      accessToken: "old-access",
      accountId: "account-id",
      connectionVersion: randomUUID(),
      accessVersion: randomUUID(),
    },
    refresh: { url: "https://tailos.example/refresh", bearer: "a".repeat(64) },
  };
}

function launchStub(
  mode: "readOnly" | "workspaceWrite",
  probeResponse:
    | { result: unknown }
    | { error: { code: number; message: string } } = {
    result: { exitCode: 0 },
  },
) {
  return (cwd: string, workspace: string) =>
    spawn(
      process.execPath,
      ["-e", script, workspace, mode, JSON.stringify(probeResponse)],
      {
        cwd,
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
}

test.for(["readOnly", "workspaceWrite"] as const)(
  "probes the %s sandbox and refreshes credentials without exposing them in the reply",
  async (mode) => {
    const job = testJob();
    if (mode === "workspaceWrite") {
      job.checkout = {
        repository: "owner/repo",
        baseSha: "a".repeat(40),
        branch: `tailos/issue-1/${job.runId}`,
        token: "checkout-token",
      };
    }
    const agent = createCodexAgent(launchStub(mode), async (url, init) => {
      expect(String(url)).toBe(job.refresh.url);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer " + job.refresh.bearer);
      expect(headers.get("X-Tailos-Access-Version")).toBe(
        job.access.accessVersion,
      );
      return Response.json({
        ...job.access,
        accessToken: "new-access",
        accessVersion: randomUUID(),
      });
    });

    expect(
      await agent.run(
        job,
        AbortSignal.timeout(10_000),
        job.checkout ? process.cwd() : undefined,
      ),
    ).toEqual({
      reply: "Reply containing [REDACTED]",
      ...(job.checkout && { headline: "fix(api): handle refresh" }),
    });
  },
);

test("rejects the job before login if Codex cannot start its command sandbox", async () => {
  const agent = createCodexAgent(
    launchStub("readOnly", { result: { exitCode: 1 } }),
  );
  await expect(
    agent.run(testJob(), AbortSignal.timeout(10_000)),
  ).rejects.toThrow(AgentSandboxUnavailable);
});

test("preserves an RPC rejection from the sandbox probe", async () => {
  const agent = createCodexAgent(
    launchStub("readOnly", {
      error: { code: -32601, message: "Method not found" },
    }),
  );
  await expect(
    agent.run(testJob(), AbortSignal.timeout(10_000)),
  ).rejects.toThrow("Codex app-server rejected a request");
});

test("reports an invalid probe response as a protocol failure", async () => {
  const agent = createCodexAgent(
    launchStub("readOnly", { result: { exitCode: "1" } }),
  );
  await expect(
    agent.run(testJob(), AbortSignal.timeout(10_000)),
  ).rejects.toThrow(ValiError);
});

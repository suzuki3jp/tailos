import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { RunnerJob } from "@meguri/core/runner";
import { AgentSandboxUnavailable } from "./agent.ts";
import { createCodexAgent } from "./codex-agent.ts";

const script = `
  const { createInterface } = require("node:readline");
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
  let sandboxReady = false;
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const reply = (result) => send({ id: request.id, result });
    if (request.method === "initialize") reply({});
    if (request.method === "command/exec") {
      if (
        request.params.command.join(" ") !== "/bin/true" ||
        request.params.sandboxPolicy.type !== "readOnly"
      ) throw new Error("Unexpected sandbox probe");
      const exitCode = Number(process.argv[1]);
      sandboxReady = exitCode === 0;
      reply({ exitCode });
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
      if (request.params.input[0].text !== "Answer the prompt") throw new Error("Unexpected turn input");
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
        item: { type: "agentMessage", text: "Reply containing new-access" },
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
    refresh: { url: "https://meguri.example/refresh", bearer: "a".repeat(64) },
  };
}

test("executes a Codex turn and replaces access tokens without exposing them in the reply", async () => {
  const job = testJob();
  const agent = createCodexAgent(
    (cwd) =>
      spawn(process.execPath, ["-e", script, "0"], {
        cwd,
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
      }),
    async (url, init) => {
      expect(String(url)).toBe(job.refresh.url);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer " + job.refresh.bearer);
      expect(headers.get("X-Meguri-Access-Version")).toBe(
        job.access.accessVersion,
      );
      return Response.json({
        ...job.access,
        accessToken: "new-access",
        accessVersion: randomUUID(),
      });
    },
  );

  expect(await agent.run(job, AbortSignal.timeout(10_000))).toBe(
    "Reply containing [REDACTED]",
  );
});

test("rejects the job before login if Codex cannot start its command sandbox", async () => {
  const agent = createCodexAgent((cwd) =>
    spawn(process.execPath, ["-e", script, "1"], {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    }),
  );
  await expect(
    agent.run(testJob(), AbortSignal.timeout(10_000)),
  ).rejects.toThrow(AgentSandboxUnavailable);
});

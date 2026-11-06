import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { RunnerJob } from "@meguri/core/runner";
import { createCodexAgent } from "./codex-agent.ts";

const script = `
  const assert = require("node:assert/strict");
  const { createInterface } = require("node:readline");
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const reply = (result) => send({ id: request.id, result });
    if (request.method === "initialize") reply({});
    if (request.method === "account/login/start") {
      assert.equal(request.params.type, "chatgptAuthTokens");
      assert.equal(request.params.accessToken, "old-access");
      assert.equal(request.params.refreshToken, undefined);
      reply({});
    }
    if (request.method === "thread/start") {
      assert.equal(request.params.ephemeral, true);
      reply({ thread: { id: "test-thread" } });
    }
    if (request.method === "turn/start") {
      assert.equal(request.params.input[0].text, "Answer the prompt");
      reply({});
      send({ id: "refresh", method: "account/chatgptAuthTokens/refresh", params: {} });
    }
    if (request.id === "refresh") {
      assert.equal(request.result.accessToken, "new-access");
      assert.equal(request.result.chatgptAccountId, "account-id");
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

test("executes a Codex turn and replaces access tokens without exposing them in the reply", async () => {
  const connectionVersion = randomUUID();
  const accessVersion = randomUUID();
  const job: RunnerJob = {
    version: 1,
    engine: "codex",
    runId: randomUUID(),
    deadlineAt: Date.now() + 15_000,
    prompt: "Answer the prompt",
    access: {
      accessToken: "old-access",
      accountId: "account-id",
      connectionVersion,
      accessVersion,
    },
    refresh: { url: "https://meguri.example/refresh", bearer: "a".repeat(64) },
  };
  const agent = createCodexAgent(
    (cwd) =>
      spawn(process.execPath, ["-e", script], {
        cwd,
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
      }),
    async (url, init) => {
      expect(String(url)).toBe(job.refresh.url);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer " + job.refresh.bearer);
      expect(headers.get("X-Meguri-Access-Version")).toBe(accessVersion);
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

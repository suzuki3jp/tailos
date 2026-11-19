import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { expect, test } from "vitest";
import { createCodexModelCatalog } from "@/codex-agent.ts";

const script = `
const { createInterface } = require("node:readline");
const mode = process.argv[1];
let initialized = false;
let loggedIn = false;
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({id: request.id, result}) + "\\n");
  if (request.method === "initialize") { reply({}); return; }
  if (request.method === "initialized") { initialized = true; return; }
  if (request.method === "account/login/start") {
    if (!initialized || request.params.type !== "chatgptAuthTokens" ||
        request.params.accessToken !== "test-access" ||
        request.params.chatgptAccountId !== "test-account" ||
        request.params.chatgptPlanType !== "plus" || "refreshToken" in request.params)
      process.exit(2);
    loggedIn = true;
    reply({}); return;
  }
  if (request.method !== "model/list" || !loggedIn) process.exit(3);
  if (mode === "hang") {
    process.stdout.write(JSON.stringify({method: "catalog/ready"}) + "\\n");
    return;
  }
  if (mode === "rejected") {
    process.stdout.write(JSON.stringify({id: request.id, error: {code: -1, message: "test-access"}}) + "\\n");
    return;
  }
  const second = request.params.cursor === "page-2";
  reply({data: [{model: second ? "second-model" : "first-model", isDefault: !second,
    supportedReasoningEfforts: mode === "invalid" ? "invalid" : [{reasoningEffort: "high"}],
    token: "must-not-return"}], nextCursor: mode === "cycle" || !second ? "page-2" : null});
});
`;

const access = {
  accessToken: "test-access",
  accountId: "test-account",
  planType: "plus",
  connectionVersion: randomUUID(),
  accessVersion: randomUUID(),
};

test.each(["success", "invalid", "cycle", "rejected", "hang"])(
  "catalog %s closes its isolated app-server and removes credentials",
  async (mode) => {
    let directory: string | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const controller = new AbortController();
    const catalog = createCodexModelCatalog((root, workspace) => {
      directory = root;
      expect(workspace).toBe(root);
      const process = spawn(globalThis.process.execPath, ["-e", script, mode], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      child = process;
      if (mode === "hang")
        process.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes('"catalog/ready"')) controller.abort();
        });
      return process;
    });
    try {
      if (mode === "success")
        expect(await catalog(access, controller.signal)).toEqual([
          { model: "first-model", efforts: ["high"] },
          { model: "second-model", efforts: ["high"] },
        ]);
      else await expect(catalog(access, controller.signal)).rejects.toThrow();
      expect(child?.killed).toBe(true);
      expect(directory).toBeDefined();
      await expect(stat(directory!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      child?.kill("SIGKILL");
    }
  },
);

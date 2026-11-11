import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import type { RunnerJob } from "@tailos/core/runner";
import { ValiError } from "valibot";
import { AgentSandboxUnavailable } from "@/agent.ts";
import { createCodexAgent } from "@/codex-agent.ts";

const script = `
  const { createInterface } = require("node:readline");
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
  const [workspace, mode, probeJson, networkJson = "false"] = process.argv.slice(1);
  const probeResponse = JSON.parse(probeJson);
  const networkAccess = JSON.parse(networkJson);
  let sandboxReady = false;
  let probePolicy;
  let githubResponses = 0;
  const refresh = () => send({ id: "refresh", method: "account/chatgptAuthTokens/refresh", params: {} });
  const lookup = (id, args, threadId = "test-thread") => send({
    id, method: "item/tool/call", params: {
      threadId, turnId: "test-turn", callId: id, namespace: null,
      tool: "tailos_github_get", arguments: args,
    },
  });
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
          sandboxPolicy.excludeSlashTmp !== true || sandboxPolicy.excludeTmpdirEnvVar !== true ||
          sandboxPolicy.networkAccess !== networkAccess ||
          sandboxPolicy.writableRoots[0] !== workspace ||
          !sandboxPolicy.writableRoots[1].endsWith("/environment")
        ))
      ) throw new Error("Unexpected sandbox probe");
      sandboxReady = probeResponse.result?.exitCode === 0;
      probePolicy = sandboxPolicy;
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
      const tools = request.params.dynamicTools;
      if (mode === "workspaceWrite" ? tools?.[0]?.name !== "tailos_github_get" : tools !== undefined)
        throw new Error("Unexpected GitHub tool registration");
      reply({ thread: { id: "test-thread" } });
    }
    if (request.method === "turn/start") {
      if (JSON.stringify(request.params.sandboxPolicy) !== JSON.stringify(probePolicy))
        throw new Error("Turn permissions must match the probed sandbox");
      const { input, outputSchema } = request.params;
      if (mode === "workspaceWrite") {
        if (!input[0].text.includes("repository instructions and CI configuration") ||
            !input[0].text.includes("commands you ran and their results") ||
            input[0].text.includes("pnpm run"))
          throw new Error("Expected repository-specific verification instructions");
        if (!input[0].text.includes("/opt/tailos-checks/node_modules/.bin/pnpm --version") ||
            !input[0].text.includes("use the bundled executable directly") ||
            !input[0].text.includes("pnpm_config_pm_on_fail=ignore"))
          throw new Error("Expected instructions to use the bundled pnpm for verification");
        if (!input[0].text.includes("Conventional Commits") || !outputSchema.required.includes("headline"))
          throw new Error("Missing repository response schema");
      } else if (input[0].text !== "Answer the prompt" || outputSchema !== undefined) {
        throw new Error("Unexpected turn input");
      }
      reply({});
      lookup("blocked", { kind: "issue", number: 17 }, mode === "workspaceWrite" ? "other-thread" : "test-thread");
      if (mode === "workspaceWrite") {
        lookup("invalid", { kind: "issue", number: 17, repository: "other/repo" });
        lookup("issue", { kind: "issue", number: 17 });
        lookup("pull_request", { kind: "pull_request", number: 34 });
      }
    }
    if (request.id === "blocked") {
      if (request.error?.message !== "Request unavailable") throw new Error("Expected lookup rejection");
      if (mode === "readOnly") refresh();
    }
    if (request.id === "invalid") {
      if (request.result?.success !== false) throw new Error("Expected invalid arguments to fail");
    }
    if (request.id === "issue" || request.id === "pull_request") {
      const text = request.result?.contentItems[0]?.text;
      if (request.result?.success !== true || JSON.parse(text).title !== request.id || text.includes("checkout-token"))
        throw new Error("Unexpected GitHub tool response");
      if (++githubResponses === 2) refresh();
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
  networkAccess = false,
) {
  return (cwd: string, workspace: string) =>
    spawn(
      process.execPath,
      [
        "-e",
        script,
        workspace,
        mode,
        JSON.stringify(probeResponse),
        JSON.stringify(networkAccess),
      ],
      {
        cwd,
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
}

test.for([
  ["readOnly", undefined],
  ["workspaceWrite", undefined],
  ["workspaceWrite", false],
  ["workspaceWrite", true],
] as const)(
  "enforces project network opt-in, scopes GitHub reads and refreshes credentials (%s)",
  async ([mode, agentNetworkAccess]) => {
    const job = testJob();
    if (mode === "workspaceWrite") {
      job.checkout = {
        repository: "owner/repo",
        baseSha: "a".repeat(40),
        branch: `tailos/issue-1/${job.runId}`,
        token: "checkout-token",
        agentNetworkAccess,
      };
    }
    const agent = createCodexAgent(
      launchStub(mode, undefined, agentNetworkAccess === true),
      async (url, init) => {
        const headers = new Headers(init?.headers);
        if (String(url) !== job.refresh.url) {
          expect(job.checkout).toBeDefined();
          expect(init?.method).toBe("GET");
          expect(init?.redirect).toBe("error");
          expect(headers.get("Authorization")).toBe("Bearer checkout-token");
          const issue =
            String(url) === "https://api.github.com/repos/owner/repo/issues/17";
          if (!issue)
            expect(String(url)).toBe(
              "https://api.github.com/repos/owner/repo/pulls/34",
            );
          return Response.json({
            number: issue ? 17 : 34,
            title: issue ? "issue" : "pull_request",
            state: "open",
            body: null,
            html_url: "https://github.com/owner/repo",
            unexpected: "checkout-token",
          });
        }
        expect(headers.get("Authorization")).toBe(
          "Bearer " + job.refresh.bearer,
        );
        expect(headers.get("X-Tailos-Access-Version")).toBe(
          job.access.accessVersion,
        );
        return Response.json({
          ...job.access,
          accessToken: "new-access",
          accessVersion: randomUUID(),
        });
      },
    );

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

test("keeps the disposable command environment out of the app-server environment", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "tailos-launch-test-"));
  t.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
  t.onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const capture = join(fixture, "launch.json");
  await writeFile(
    join(fixture, "codex"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const env = process.env;
const shellEnvironment = Object.fromEntries(args.filter(arg => arg.startsWith("shell_environment_policy.set.")).map(arg => {
  const index = arg.indexOf("=");
  return [arg.slice("shell_environment_policy.set.".length, index), JSON.parse(arg.slice(index + 1))];
}));
const environment = path.dirname(shellEnvironment.HOME);
for (const dir of ["home", "tmp", "runtime", "cache", "tools/bin"]) {
  fs.writeFileSync(path.join(environment, dir, "probe"), "writable");
}
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ shellEnvironment, env }));
process.argv = ["node", ${JSON.stringify(process.cwd())}, "workspaceWrite", JSON.stringify({ result: { exitCode: 1 } })];
${script}`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", [fixture, process.env.PATH].join(delimiter));
  vi.stubEnv("TAILOS_TEST_SECRET", "must-not-reach-child");
  const job = testJob();
  job.checkout = {
    repository: "owner/repo",
    baseSha: "a".repeat(40),
    branch: `tailos/issue-1/${job.runId}`,
    token: "checkout-token",
  };

  await expect(
    createCodexAgent().run(job, AbortSignal.timeout(10_000), process.cwd()),
  ).rejects.toThrow(AgentSandboxUnavailable);

  const { shellEnvironment, env } = JSON.parse(await readFile(capture, "utf8"));
  const environment = dirname(shellEnvironment.HOME);
  expect(shellEnvironment.TMPDIR).toBe(join(environment, "tmp"));
  expect(shellEnvironment.XDG_RUNTIME_DIR).toBe(join(environment, "runtime"));
  expect(shellEnvironment.XDG_CACHE_HOME).toBe(join(environment, "cache"));
  expect(shellEnvironment.PNPM_HOME).toBe(join(environment, "tools"));
  expect(shellEnvironment.npm_config_prefix).toBe(shellEnvironment.PNPM_HOME);
  expect(shellEnvironment.PATH.split(delimiter).slice(0, 2)).toEqual([
    join(environment, "tools", "bin"),
    join(environment, "tools"),
  ]);
  expect(resolve(env.CODEX_HOME)).not.toBe(resolve(environment));
  expect(env.HOME).toBeUndefined();
  expect(env.TMPDIR).toBeUndefined();
  expect(env.XDG_RUNTIME_DIR).toBeUndefined();
  expect(env.XDG_CACHE_HOME).toBeUndefined();
  expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(env.TAILOS_TEST_SECRET).toBeUndefined();
  await expect(stat(dirname(environment))).rejects.toMatchObject({
    code: "ENOENT",
  });
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

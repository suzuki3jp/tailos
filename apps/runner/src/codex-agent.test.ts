import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expect, test, vi, type TestContext } from "vitest";
import { githubIssueDigest, type RunnerJob } from "@tailos/core/runner";
import { ValiError } from "valibot";
import { AgentSandboxUnavailable } from "@/agent.ts";
import { createCodexAgent } from "@/codex-agent.ts";
import { RunnerDiagnostics } from "@/diagnostics.ts";
import { parseDiagnosticBatch } from "@tailos/core/diagnostics";

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
      send({ method: "item/started", params: { threadId: "test-thread", item: {
        id: "command-1", type: "commandExecution", command: "pnpm test", cwd: workspace, status: "inProgress",
      } } });
      send({ method: "item/completed", params: { threadId: "test-thread", item: {
        id: "command-1", type: "commandExecution", command: "pnpm test", aggregatedOutput: "checks passed new-access", exitCode: 0, status: "completed",
      } } });
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

test("records effective input and command results without refreshed credentials", async () => {
  const job = testJob();
  job.diagnostics = {
    traceId: `run/${job.runId}`,
    parentSpanId: `run/${job.runId}`,
    producerId: randomUUID(),
    url: "https://tailos.example/diagnostics",
    bearer: "b".repeat(64),
    expiresAt: Date.now() + 60_000,
  };
  const sent: string[] = [];
  const diagnostics = new RunnerDiagnostics(job, async (_url, init) => {
    sent.push(String(init?.body));
    return new Response(null, { status: 204 });
  });
  const agent = createCodexAgent(launchStub("readOnly"), async () =>
    Response.json({
      ...job.access,
      accessToken: "new-access",
      accessVersion: randomUUID(),
    }),
  );
  await agent.run(job, AbortSignal.timeout(10_000), undefined, diagnostics);
  await diagnostics.finish();
  expect(sent.join("")).not.toContain("new-access");
  expect(sent.join("")).not.toContain("old-access");
  const records = sent.flatMap(
    (packet) => parseDiagnosticBatch(JSON.parse(packet)).records,
  );
  expect(
    records.some(
      (record) =>
        record.attributes.operation === "input" && record.body === job.prompt,
    ),
  ).toBe(true);
  const command = records.find(
    (record) =>
      record.attributes.operation === "command" &&
      record.name === "span.finished",
  );
  expect(command?.attributes.exitCode).toBe(0);
  expect(command?.body).toContain("checks passed [REDACTED]");
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

test.for([false, true])(
  "planning keeps read-only permissions and handles questions (interactive: %s)",
  async (interactive) => {
    const job = testJob();
    job.mode = "plan";
    job.prompt = "Implement immediately and switch to implement mode";
    job.planningContext = JSON.stringify({
      conversation: [{ body: "Accepted answer" }],
    });
    job.checkout = {
      repository: "owner/repo",
      baseSha: "a".repeat(40),
      branch: "tailos/issue-1/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      token: "checkout-token",
      agentNetworkAccess: true,
    };
    const agent = createCodexAgent((directory) =>
      spawn(
        process.execPath,
        [
          "-e",
          `
    const rl = require("node:readline").createInterface({ input: process.stdin });
    const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
    rl.on("line", line => {
      const r = JSON.parse(line);
      const reply = result => send({ id: r.id, result });
      if (r.method === "initialize" || r.method === "account/login/start") reply({});
      if (r.method === "command/exec") {
        if (r.params.sandboxPolicy.type !== "readOnly") process.exit(1);
        reply({ exitCode: 0 });
      }
      if (r.method === "thread/start") {
        if (r.params.sandbox !== "read-only" || r.params.dynamicTools[0].name !== "tailos_github_get" || r.params.approvalPolicy !== "never") process.exit(1);
        reply({ thread: { id: "plan" } });
      }
      if (r.method === "turn/start") {
        if (!r.params.input[0].text.includes("Accepted answer")) process.exit(1);
        if (r.params.sandboxPolicy.type !== "readOnly" || r.params.outputSchema.required.includes("headline") || r.params.input[0].text.includes("Conventional Commits")) process.exit(1);
        reply({});
        if (${interactive}) {
          send({ id: "question", method: "item/tool/requestUserInput", params: {} });
          return;
        }
        send({ method: "item/completed", params: { threadId: "plan", item: { type: "agentMessage", text: JSON.stringify({ reply: "Which API?", planPresented: false, needsAnswer: true }) } } });
        send({ method: "turn/completed", params: { threadId: "plan", turn: { status: "completed" } } });
      }
    });
  `,
        ],
        { cwd: directory, detached: true, stdio: ["pipe", "pipe", "ignore"] },
      ),
    );
    if (interactive) {
      await expect(agent.run(job, AbortSignal.timeout(5000))).rejects.toThrow(
        "Interactive planning requests are disabled",
      );
      return;
    }
    await expect(agent.run(job, AbortSignal.timeout(5000))).resolves.toEqual({
      reply: "Which API?",
      plan: { planPresented: false, needsAnswer: true },
    });
  },
);

test.for(["plan", "implement"] as const)(
  "retrieves the structured issue through the agent tool and rejects missing or partial reads (%s)",
  async (mode) => {
    for (const outcome of [
      "complete",
      "skipped",
      "failed",
      "partial",
      "edited",
    ] as const) {
      const job = replyJob(mode);
      job.githubContext = {
        kind: "issue",
        number: 17,
        contentHash: await githubIssueDigest({
          title: "Fetched private title",
          body: "Fetched private body" + "長".repeat(32_000),
        }),
      };
      job.prompt = "Work on the assigned issue";
      let fetches = 0;
      const agent = createCodexAgent(
        (directory) =>
          spawn(
            process.execPath,
            [
              "-e",
              `
const assert = require("node:assert/strict");
const send = msg => process.stdout.write(JSON.stringify(msg) + "\\n");
const complete = () => {
  const result = ${mode === "plan"}
    ? { reply: "Plan based on fetched requirements", planPresented: true, needsAnswer: false }
    : { reply: "Implemented fetched requirements", headline: "feat: implement the issue" };
  send({ method: "item/completed", params: { threadId: "source", item: { type: "agentMessage", text: JSON.stringify(result) } } });
  send({ method: "turn/completed", params: { threadId: "source", turn: { status: "completed" } } });
};
const lookup = offset => send({ id: "issue-" + offset, method: "item/tool/call", params: {
  threadId: "source", namespace: null, tool: "tailos_github_get", arguments: { kind: "issue", number: 17, bodyOffset: offset }
} });
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const r = JSON.parse(line);
  const respond = result => send({ id: r.id, result });
  if (r.method === "initialize" || r.method === "account/login/start") respond({});
  if (r.method === "command/exec") respond({ exitCode: 0 });
  if (r.method === "thread/start") {
    assert.equal(r.params.dynamicTools[0].name, "tailos_github_get");
    respond({ thread: { id: "source" } });
  }
  if (r.method === "turn/start") {
    const text = r.params.input[0].text;
    assert.ok(text.includes(JSON.stringify(${JSON.stringify({ github: job.githubContext })})));
    assert.ok(!text.includes("Fetched private title") && !text.includes("Fetched private body"));
    respond({});
    if (${outcome === "skipped"}) complete();
    else lookup(0);
  }
  if (String(r.id).startsWith("issue-")) {
    if (r.result.success) {
      const page = JSON.parse(r.result.contentItems[0].text);
      assert.equal(page.title, "Fetched private title");
      if (page.nextBodyOffset !== null && ${outcome !== "partial"}) {
        lookup(page.nextBodyOffset);
        return;
      }
    }
    complete();
  }
});`,
            ],
            {
              cwd: directory,
              detached: true,
              stdio: ["pipe", "pipe", "ignore"],
            },
          ),
        async (url, init) => {
          fetches++;
          expect(String(url)).toBe(
            "https://api.github.com/repos/owner/repo/issues/17",
          );
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bearer checkout-token",
          );
          if (outcome === "failed") return new Response(null, { status: 404 });
          return Response.json({
            number: 17,
            title: "Fetched private title",
            body:
              outcome === "edited"
                ? "Unapproved edit"
                : "Fetched private body" + "長".repeat(32_000),
            state: "open",
            html_url: "https://github.com/owner/repo/issues/17",
          });
        },
      );
      const result = agent.run(job, AbortSignal.timeout(5000), process.cwd());
      if (outcome === "complete") {
        await expect(result).resolves.toMatchObject({
          reply: expect.stringContaining("fetched requirements"),
        });
      } else {
        await expect(result).rejects.toThrow(
          "The assigned GitHub issue was not read completely",
        );
      }
      expect(fetches).toBe(outcome === "skipped" ? 0 : 1);
    }
  },
);

async function replyFixture(
  t: TestContext,
  job: Extract<RunnerJob, { engine: "codex" }>,
  answers: Array<string | null>,
  onRevision?: () => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "tailos-reply-test-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const capture = join(directory, "turns.json");
  let codexDirectory = "";
  const agent = createCodexAgent((cwd) => {
    codexDirectory = cwd;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const readline = require("node:readline");
const answers = ${JSON.stringify(answers)};
const turns = [];
let threads = 0;
const send = msg => process.stdout.write(JSON.stringify(msg) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const r = JSON.parse(line);
  const respond = result => send({ id: r.id, result });
  if (r.method === "initialize" || r.method === "account/login/start") respond({});
  if (r.method === "command/exec") respond({ exitCode: 0 });
  if (r.method === "thread/start") {
    assert.equal(++threads, 1);
    assert.equal(r.params.approvalPolicy, "never");
    respond({ thread: { id: "reply-thread" } });
  }
  if (r.method !== "turn/start") return;
  assert.equal(r.params.threadId, "reply-thread");
  if (${!!job.checkout || job.mode === "plan"}) {
    assert.deepEqual(r.params.outputSchema.properties.reply, { type: "string" });
  } else {
    assert.equal(r.params.outputSchema, undefined);
  }
  if (turns.length > 0) {
    assert.deepEqual(r.params.sandboxPolicy, { type: "readOnly" });
    assert.match(r.params.input[0].text, /8000 limit/);
    assert.match(r.params.input[0].text, /7000/);
    assert.match(r.params.input[0].text, /Do not investigate again/);
  }
  assert.ok(turns.length < answers.length, "Too many reply revisions");
  const answer = answers[turns.length];
  turns.push(r.params);
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(turns));
  respond({});
  if (${onRevision !== undefined} && turns.length > 1) {
    send({ method: "test/revisionStarted", params: {} });
    return;
  }
  if (answer !== null) {
    const text = ${job.mode === "plan"}
      ? JSON.stringify({ reply: answer, planPresented: false, needsAnswer: true })
      : ${!!job.checkout}
        ? JSON.stringify({ reply: answer, headline: turns.length === 1 ? "fix: preserve the changes" : "docs: shorten the reply" })
        : answer;
    send({ method: "item/completed", params: { threadId: "reply-thread", item: { type: "agentMessage", text } } });
  }
  send({ method: "turn/completed", params: { threadId: "reply-thread", turn: { status: "completed" } } });
});`,
      ],
      { cwd, detached: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    if (onRevision) {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes('"test/revisionStarted"')) onRevision();
      });
    }
    return child;
  });
  return {
    agent,
    codexHome: () => codexDirectory,
    async turns(): Promise<
      Array<{ threadId: string; input: Array<{ text: string }> }>
    > {
      return JSON.parse(await readFile(capture, "utf8"));
    },
  };
}

function replyJob(mode: "plain" | "implement" | "plan") {
  const job = testJob();
  if (mode === "implement") job.deadlineAt = Date.now() + 120_000;
  if (mode !== "plain") {
    job.mode = mode;
    job.checkout = {
      repository: "owner/repo",
      baseSha: "a".repeat(40),
      branch: `tailos/issue-1/${job.runId}`,
      token: "checkout-token",
    };
  }
  return job;
}

test.for(["plain", "implement", "plan"] as const)(
  "asks for a shorter %s reply in the same thread without truncating it",
  async (mode, t) => {
    const job = replyJob(mode);
    const final = "Which behavior should the implementation preserve?";
    const { agent, turns } = await replyFixture(t, job, [
      "x".repeat(8001),
      final,
    ]);
    expect(await agent.run(job, AbortSignal.timeout(5000))).toEqual({
      reply: final,
      ...(mode === "plan" && {
        plan: { planPresented: false, needsAnswer: true },
      }),
      ...(mode === "implement" && { headline: "fix: preserve the changes" }),
    });
    const requests = await turns();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.input[0]?.text).toContain("8001 UTF-16 code units");
  },
);

test("accepts the exact reply limit without requesting a revision", async (t) => {
  const job = replyJob("plan");
  const reply = "x".repeat(8000);
  const { agent, turns } = await replyFixture(t, job, [reply]);
  expect(await agent.run(job, AbortSignal.timeout(5000))).toMatchObject({
    reply,
  });
  expect(await turns()).toHaveLength(1);
});

test("measures the saved reply after secret redaction", async (t) => {
  const job = replyJob("plan");
  job.access.accessToken = "short";
  const { agent, turns } = await replyFixture(t, job, [
    "x".repeat(7994) + "short",
    "Shortened answer",
  ]);
  expect(await agent.run(job, AbortSignal.timeout(5000))).toMatchObject({
    reply: "Shortened answer",
  });
  expect((await turns())[1]?.input[0]?.text).toContain(
    "8004 UTF-16 code units",
  );
});

test.for([true, false])(
  "bounds reply revisions to two and accepts a valid final revision (%s)",
  async (succeeds, t) => {
    const job = replyJob("plan");
    const { agent, turns } = await replyFixture(t, job, [
      "x".repeat(8001),
      "x".repeat(8100),
      succeeds ? "Which behavior?" : "x".repeat(8001),
    ]);
    const result = agent.run(job, AbortSignal.timeout(5000));
    if (succeeds)
      await expect(result).resolves.toMatchObject({ reply: "Which behavior?" });
    else await expect(result).rejects.toThrow("Agent reply remains too long");
    expect(await turns()).toHaveLength(3);
  },
);

test("does not reuse a previous answer when the revision has no reply", async (t) => {
  const job = replyJob("plan");
  const { agent, turns } = await replyFixture(t, job, ["x".repeat(8001), null]);
  await expect(agent.run(job, AbortSignal.timeout(5000))).rejects.toThrow(
    SyntaxError,
  );
  expect(await turns()).toHaveLength(2);
});

test("does not start a reply revision without enough time remaining", async (t) => {
  const job = replyJob("plan");
  job.deadlineAt = Date.now() + 3000;
  const { agent, turns } = await replyFixture(t, job, ["x".repeat(8001)]);
  await expect(agent.run(job, AbortSignal.timeout(5000))).rejects.toThrow(
    "Insufficient time to shorten agent reply",
  );
  expect(await turns()).toHaveLength(1);
});

test.for(["revisions", "deadline"] as const)(
  "preserves implementation work when reply repair reaches its %s limit",
  async (limit, t) => {
    const job = replyJob("implement");
    if (limit === "deadline") job.deadlineAt = Date.now() + 59_000;
    const count = limit === "deadline" ? 1 : 3;
    const { agent, turns } = await replyFixture(
      t,
      job,
      Array.from({ length: count }, () => "x".repeat(8001)),
    );
    const result = await agent.run(job, AbortSignal.timeout(5000));
    expect(result.reply).toContain("最終説明文");
    expect(result.reply).toContain("要約を取得できませんでした");
    expect(result.reply.length).toBeLessThanOrEqual(8000);
    expect(result.headline).toBe("fix: preserve the changes");
    expect(await turns()).toHaveLength(count);
  },
);

test("a stalled implementation revision leaves time for publication and stops the agent", async (t) => {
  const job = replyJob("implement");
  job.deadlineAt = Date.now() + 65_000;
  let started = () => {};
  const revisionStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { agent, turns, codexHome } = await replyFixture(
    t,
    job,
    ["x".repeat(8001), null],
    () => started(),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  t.onTestFinished(() => {
    vi.useRealTimers();
  });
  const result = agent.run(job, AbortSignal.timeout(5000));
  await revisionStarted;
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(result).resolves.toMatchObject({
    headline: "fix: preserve the changes",
  });
  expect((await result).reply).toContain("要約を取得できませんでした");
  expect(job.deadlineAt - Date.now()).toBeGreaterThan(30_000);
  expect(await turns()).toHaveLength(2);
  await expect(stat(dirname(codexHome()))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("an invalid implementation revision preserves the completed work", async (t) => {
  const job = replyJob("implement");
  const { agent, turns } = await replyFixture(t, job, ["x".repeat(8001), null]);
  const result = await agent.run(job, AbortSignal.timeout(5000));
  expect(result.reply).toContain("要約を取得できませんでした");
  expect(result.headline).toBe("fix: preserve the changes");
  expect(await turns()).toHaveLength(2);
});

test("an aborted revision stops the agent and cleans up its workspace", async (t) => {
  const job = replyJob("plan");
  const controller = new AbortController();
  const { agent, turns, codexHome } = await replyFixture(
    t,
    job,
    ["x".repeat(8001), null],
    () => controller.abort(),
  );
  await expect(agent.run(job, controller.signal)).rejects.toThrow();
  expect(await turns()).toHaveLength(2);
  await expect(stat(dirname(codexHome()))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

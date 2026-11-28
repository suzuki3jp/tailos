import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { assert, expect, test, type TestContext } from "vitest";
import { rolloutPath } from "@/continuity.ts";
import * as v from "valibot";

// Resuming a Session's conversation depends on how this Codex version keeps
// its rollout, which is not a public contract: run the real CLI. Codex talks
// to a local stand-in for the model API, with a fake unsigned token.
const codex = createRequire(import.meta.url).resolve(
  "@openai/codex/bin/codex.js",
);

async function modelStub(t: TestContext) {
  const inputs: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    inputs.push(JSON.stringify(body.input ?? []));
    const id = `response-${inputs.length}`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id } },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: `message-${inputs.length}`,
          content: [{ type: "output_text", text: "Noted." }],
        },
      },
      {
        type: "response.completed",
        response: {
          id,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
            total_tokens: 2,
          },
        },
      },
    ])
      response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  assert(address && typeof address === "object");
  return { port: address.port, inputs };
}

function appServer(t: TestContext, home: string, cwd: string, port: number) {
  const child = spawn(
    process.execPath,
    [
      codex,
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
      'model_provider="stub"',
      "-c",
      'model="gpt-5.4"',
      "-c",
      `model_providers.stub={name="stub",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=true}`,
    ],
    {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  t.onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const listeners = new Set<(message: Record<string, unknown>) => void>();
  let next = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method) {
      // Requests from Codex, such as a token refresh, are declined.
      child.stdin.write(
        JSON.stringify({
          id: message.id,
          error: { code: -32000, message: "unavailable" },
        }) + "\n",
      );
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        entry?.reject(new Error(JSON.stringify(message.error)));
      else entry?.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  const call = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  return {
    async start() {
      await call("initialize", {
        clientInfo: { name: "tailos-test", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      // As in a Run, the token is passed again to every new process.
      await call("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: fakeToken(),
        chatgptAccountId: "account",
        chatgptPlanType: "plus",
      });
    },
    call,
    async turn(threadId: string, text: string) {
      const completed = new Promise<any>((resolve) => {
        const listener = (message: Record<string, unknown>) => {
          const params = message.params as { threadId?: string } | undefined;
          if (
            message.method !== "turn/completed" ||
            params?.threadId !== threadId
          )
            return;
          listeners.delete(listener);
          resolve(message.params);
        };
        listeners.add(listener);
      });
      await call("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      return (await completed).turn;
    },
    async kill() {
      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
}

const fakeToken = () =>
  [
    { alg: "none", typ: "JWT" },
    {
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
        chatgpt_account_id: "account",
      },
    },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("signature")
    .join(".");

test(
  "the installed Codex resumes a Session's thread from its rollout alone in another process and directory",
  { timeout: 60_000 },
  async (t) => {
    // Codex reports real paths, so compare them under the real directory.
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "tailos-codex-resume-")),
    );
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const model = await modelStub(t);
    const first = { home: join(root, "home-1"), cwd: join(root, "work-1") };
    const second = { home: join(root, "home-2"), cwd: join(root, "work-2") };
    for (const directory of [first.home, first.cwd, second.home, second.cwd])
      await mkdir(directory, { recursive: true });

    const a = appServer(t, first.home, first.cwd, model.port);
    await a.start();
    const started = await a.call("thread/start", {
      cwd: first.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
    });
    const threadId: string = started.thread.id;
    expect((await a.turn(threadId, "Remember PINEAPPLE-42")).status).toBe(
      "completed",
    );
    // The container goes away without a clean shutdown.
    await a.kill();

    // Only the rollout moves, to the same path in a fresh CODEX_HOME.
    const path = v.parse(
      rolloutPath,
      relative(first.home, started.thread.path),
    );
    await mkdir(dirname(join(second.home, path)), { recursive: true });
    await writeFile(
      join(second.home, path),
      await readFile(join(first.home, path)),
    );

    const b = appServer(t, second.home, second.cwd, model.port);
    await b.start();
    const resumed = await b.call("thread/resume", {
      threadId,
      cwd: second.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(resumed.thread.id).toBe(threadId);
    expect(
      (await b.turn(threadId, "What did I ask you to remember?")).status,
    ).toBe("completed");
    const last = model.inputs.at(-1)!;
    expect(last).toContain("Remember PINEAPPLE-42");
    expect(last).toContain("What did I ask you to remember?");
  },
);

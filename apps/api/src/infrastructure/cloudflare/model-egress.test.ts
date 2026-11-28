import { expect, test, vi } from "vitest";
import {
  forwardClaudeRequest,
  forwardModelRequest,
} from "@/infrastructure/cloudflare/model-egress.ts";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const access = {
  accessToken: "real-access",
  accountId: "account-id",
  accessVersion: "version-1",
};

function capture(status = 200) {
  const sent: Request[] = [];
  const upstream = vi.fn(async (input: RequestInfo | URL) => {
    sent.push(input as Request);
    return new Response("ok", { status });
  });
  return { sent, upstream: upstream as unknown as typeof fetch };
}

test("adds the Run's access token in place of the container's placeholder", async () => {
  const { sent, upstream } = capture();
  const rejected = vi.fn(async () => {});
  const response = await forwardModelRequest(
    new Request("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: '{"input":[]}',
      headers: {
        Authorization: "Bearer placeholder",
        "ChatGPT-Account-Id": "someone-else",
        Cookie: "session=1",
        "Content-Type": "application/json",
      },
    }),
    async () => access,
    rejected,
    upstream,
  );
  expect(response.status).toBe(200);
  const [request] = sent;
  expect(request!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(request!.headers.get("Authorization")).toBe("Bearer real-access");
  expect(request!.headers.get("ChatGPT-Account-Id")).toBe("account-id");
  expect(request!.headers.get("Cookie")).toBeNull();
  expect(request!.headers.get("Content-Type")).toBe("application/json");
  expect(request!.redirect).toBe("manual");
  expect(await request!.text()).toBe('{"input":[]}');
  expect(rejected).not.toHaveBeenCalled();
});

test("passes a WebSocket upgrade through with the token", async () => {
  const { sent, upstream } = capture();
  await forwardModelRequest(
    new Request("https://chatgpt.com/backend-api/codex/responses", {
      headers: { Upgrade: "websocket", Authorization: "Bearer placeholder" },
    }),
    async () => access,
    async () => {},
    upstream,
  );
  expect(sent[0]!.method).toBe("GET");
  expect(sent[0]!.headers.get("Upgrade")).toBe("websocket");
  expect(sent[0]!.headers.get("Authorization")).toBe("Bearer real-access");
});

test.for([
  "https://chatgpt.com/backend-api/wham/accounts/check",
  "https://chatgpt.com/backend-api/wham/usage",
])(
  "adds the token to the account queries that Codex makes (%s)",
  async (url) => {
    const { sent, upstream } = capture();
    await forwardModelRequest(
      new Request(url),
      async () => access,
      async () => {},
      upstream,
    );
    expect(sent[0]!.headers.get("Authorization")).toBe("Bearer real-access");
  },
);

test("records a rejected token so the next request refreshes it", async () => {
  const { upstream } = capture(401);
  const rejected = vi.fn(async () => {});
  const response = await forwardModelRequest(
    new Request("https://chatgpt.com/backend-api/codex/responses"),
    async () => access,
    rejected,
    upstream,
  );
  expect(response.status).toBe(401);
  expect(rejected).toHaveBeenCalledExactlyOnceWith("version-1");
});

test("never attaches the token to another host, scheme, port or a finished Run", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { upstream } = capture();
    const token = vi.fn(async () => access);
    for (const url of [
      "https://example.com/",
      "https://api.openai.com/v1/responses",
      "http://chatgpt.com/backend-api/codex/responses",
      "https://chatgpt.com:8443/backend-api/codex/responses",
      "https://chatgpt.com/backend-api/conversations",
      "https://chatgpt.com/backend-api/wham/tasks",
      "https://chatgpt.com/backend-api/codex",
      "https://chatgpt.com/backend-api/codex/../conversations",
      "https://chatgpt.com/backend-api/codex/%2e%2e/conversations",
      "https://chatgpt.com/backend-api/codex/..%2Fconversations",
      "https://chatgpt.com/backend-api/codex/%5C..%5Cconversations",
    ]) {
      const response = await forwardModelRequest(
        new Request(url),
        token,
        async () => {},
        upstream,
      );
      expect(response.status, url).toBe(403);
    }
    expect(token).not.toHaveBeenCalled();
    for (const finished of [async () => null, async () => Promise.reject()]) {
      const response = await forwardModelRequest(
        new Request("https://chatgpt.com/backend-api/codex/responses"),
        finished,
        async () => {},
        upstream,
      );
      expect(response.status).toBe(401);
    }
    expect(upstream).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("logs only the Run, host and path of a refused request", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { upstream } = capture();
    const response = await forwardModelRequest(
      new Request("https://chatgpt.com/backend-api/conversations?token=x", {
        headers: { Authorization: "Bearer placeholder", Cookie: "session=1" },
      }),
      async () => access,
      async () => {},
      upstream,
      "run-1",
    );
    expect(response.status).toBe(403);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Model egress denied a request",
      {
        runId: "run-1",
        host: "chatgpt.com",
        path: "/backend-api/conversations",
      },
    );
  } finally {
    warn.mockRestore();
  }
});

test("adds the Run's Claude token in place of the container's placeholder", async () => {
  const { sent, upstream } = capture(401);
  const response = await forwardClaudeRequest(
    new Request("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      body: '{"messages":[]}',
      headers: {
        Authorization: "Bearer sk-ant-oat01-tailos-placeholder",
        "X-Api-Key": "someone-else",
        Cookie: "session=1",
        "anthropic-beta": "oauth-2025-04-20",
      },
    }),
    async () => "sk-ant-oat01-real",
    upstream,
  );
  // A pasted token cannot be refreshed: a 401 goes back to Claude Code as is.
  expect(response.status).toBe(401);
  const [request] = sent;
  expect(request!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  expect(request!.headers.get("Authorization")).toBe(
    "Bearer sk-ant-oat01-real",
  );
  expect(request!.headers.get("X-Api-Key")).toBeNull();
  expect(request!.headers.get("Cookie")).toBeNull();
  expect(request!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
  expect(await request!.text()).toBe('{"messages":[]}');
});

test.for([
  "https://api.anthropic.com/v1/organizations",
  "https://api.anthropic.com/api/oauth/profile",
  "https://api.anthropic.com/v1/messages/batches",
  "https://api.anthropic.com/v1/messages%2Fbatches",
  "https://api.anthropic.com:8443/v1/messages",
  "https://chatgpt.com/v1/messages",
])("adds the Claude token to no other request (%s)", async (url) => {
  const { sent, upstream } = capture();
  const token = vi.fn(async () => "sk-ant-oat01-real");
  const response = await forwardClaudeRequest(
    new Request(url, { method: "POST" }),
    token,
    upstream,
  );
  expect(response.status).toBe(403);
  expect(token).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});

test("refuses a Claude request once the Run's token is unavailable", async () => {
  const { sent, upstream } = capture();
  const response = await forwardClaudeRequest(
    new Request("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
    }),
    async () => null,
    upstream,
  );
  expect(response.status).toBe(401);
  expect(sent).toEqual([]);
});

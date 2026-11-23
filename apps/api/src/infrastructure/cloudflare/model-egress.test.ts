import { expect, test, vi } from "vitest";
import { forwardModelRequest } from "@/infrastructure/cloudflare/model-egress.ts";

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
  const { upstream } = capture();
  const token = vi.fn(async () => access);
  for (const url of [
    "https://example.com/",
    "https://api.openai.com/v1/responses",
    "http://chatgpt.com/backend-api/codex/responses",
    "https://chatgpt.com:8443/backend-api/codex/responses",
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
});

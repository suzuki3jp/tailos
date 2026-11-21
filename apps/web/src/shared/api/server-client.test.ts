import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../config");
  vi.doUnmock("cloudflare:workers");
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("uses the pinned API deployment for authenticated Preview SSR", async () => {
  vi.doMock("../config", () => ({
    apiOrigin: "https://pr-123.preview.example",
    isPreview: true,
  }));
  const origin = "https://deployment-pr-123.preview-api.example";
  vi.doMock("cloudflare:workers", () => ({
    env: {
      TAILOS_PREVIEW_API_ORIGIN: origin,
      TAILOS_PREVIEW_PROXY_SECRET: "test-only-proxy-secret",
    },
  }));
  const http = vi.fn<typeof fetch>(async () => new Response());
  vi.stubGlobal("fetch", http);
  const { createServerApi } = await import("./server-client");
  const session = "__Secure-tailos.session_token=example";
  await createServerApi(`${session}; other=private`).projects.$get();
  const [url, init] = http.mock.calls[0];
  expect(String(url)).toBe(`${origin}/v1/projects`);
  expect(new Headers(init?.headers).get("Cookie")).toBe(session);
  expect(new Headers(init?.headers).get("X-Tailos-Preview-Proxy")).toBe(
    "test-only-proxy-secret",
  );
  expect(init?.redirect).toBe("manual");
});

test.each([
  {
    origin: "https://api.tailos.example",
    name: "__Secure-tailos.session_token",
    other: "tailos.session_token",
  },
  {
    origin: "http://localhost:8787",
    name: "tailos.session_token",
    other: "__Secure-tailos.session_token",
  },
])(
  "forwards only the correct session cookie and never follows redirects from $origin",
  async ({ origin, name, other }) => {
    vi.resetModules();
    vi.doMock("../config", () => ({
      apiOrigin: origin,
      isPreview: false,
    }));
    const { createServerApi } = await import("./server-client");
    const http = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://unrelated.example" },
        }),
    );
    vi.stubGlobal("fetch", http);
    const api = createServerApi(
      `${other}=wrong; ${name}=correct; tracking=private`,
    );
    const controller = new AbortController();
    const response = await api.projects.$get(undefined, {
      init: { signal: controller.signal },
    });
    expect(response.status).toBe(302);
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(new URL(String(url)).origin).toBe(origin);
    expect(new Headers(init?.headers).get("Cookie")).toBe(`${name}=correct`);
    expect(init).toMatchObject({
      signal: controller.signal,
      cache: "no-store",
      redirect: "manual",
    });
  },
);

test.each(["request", "query"])(
  "combines request and query cancellation when the %s is aborted",
  async (cancel) => {
    const { createServerApi } = await import("./server-client");
    const request = new AbortController();
    const query = new AbortController();
    const http = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing fetch signal");
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", http);
    const api = createServerApi("", request.signal);
    const pending = api.projects.$get(undefined, {
      init: { signal: query.signal },
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    (cancel === "request" ? request : query).abort();
    await rejected;
    expect(http.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect((cancel === "request" ? query : request).signal.aborted).toBe(false);
  },
);

import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../config");
  vi.doUnmock("cloudflare:workers");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
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
      browserApiBaseUrl: `${origin}/v1`,
      usesWebApiProxy: false,
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

test("uses the production binding for SSR and sends only the host cookie", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([]));
  vi.doMock("../config", () => ({
    apiOrigin: "https://tailos.app",
    browserApiBaseUrl: "https://tailos.app/api/v1",
    usesWebApiProxy: true,
    isPreview: false,
  }));
  vi.doMock("cloudflare:workers", () => ({ env: { BROWSER_API: { fetch } } }));
  const { createServerApi } = await import("./server-client");
  const api = createServerApi(
    "__Secure-tailos.session_token=old; __Host-tailos.session_token=new; tracking=ignored",
  );

  expect((await api.projects.$get()).status).toBe(200);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0];
  expect(String(url)).toBe("https://tailos.app/api/v1/projects");
  expect(new Headers(init?.headers).get("Cookie")).toBe(
    "__Host-tailos.session_token=new",
  );
  expect(init).toMatchObject({ cache: "no-store", redirect: "manual" });
});

test("sends only the Preview session cookie to the pinned API deployment", async () => {
  vi.stubEnv("VITE_TAILOS_PREVIEW_ORIGIN", "https://pr-123.preview.tailos.app");
  const upstream = "https://a1b2c3d4-pr-123.preview-api.tailos.app";
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([]));
  const production = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.doMock("cloudflare:workers", () => ({
    env: {
      TAILOS_PREVIEW_API_ORIGIN: upstream,
      TAILOS_PREVIEW_PROXY_SECRET: "test-preview-proxy",
      BROWSER_API: { fetch: production },
    },
  }));
  const { createServerApi } = await import("./server-client");
  const api = createServerApi(
    "__Host-tailos.session_token=production; __Host-tailos-preview.session_token=preview; tracking=ignored",
  );

  expect((await api.projects.$get()).status).toBe(200);
  expect(production).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
  const request = fetch.mock.calls[0][0] as Request;
  expect(request.url).toBe(`${upstream}/api/v1/projects`);
  expect(request.headers.get("Cookie")).toBe(
    "__Host-tailos-preview.session_token=preview",
  );
  expect(request.headers.get("X-Tailos-Preview-Proxy")).toBe(
    "test-preview-proxy",
  );
  expect(request.redirect).toBe("manual");
  expect(request.cache).toBe("no-store");
});

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

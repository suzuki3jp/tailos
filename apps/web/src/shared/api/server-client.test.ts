import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../config");
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
    vi.doMock("../config", () => ({ apiOrigin: origin }));
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

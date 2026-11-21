import { afterEach, assert, expect, test, vi } from "vitest";
import worker from "@/worker/index.ts";

const render = vi.hoisted(() =>
  vi.fn<(request: Request) => Promise<Response>>(),
);
const config = vi.hoisted(() => ({ isPreview: false }));

vi.mock("vinext/server/fetch-handler", () => ({ default: { fetch: render } }));
vi.mock("@/shared/config", () => ({
  apiOrigin: "https://api.tailos.example",
  get isPreview() {
    return config.isPreview;
  },
}));

const env = { ASSETS: { fetch: vi.fn(), connect: vi.fn() } };
// The mocked renderer never reads the platform context.
const context = {} as ExecutionContext;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  config.isPreview = false;
  render.mockReset();
});

test("protects HTML documents and gives vinext the same fresh nonce as the browser", async () => {
  vi.stubEnv("DEV", false);
  render.mockImplementation(
    async () =>
      new Response("<h1>Tailos</h1>", {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  );
  const request = new Request("https://tailos.example/login", {
    headers: { "Content-Security-Policy": "script-src 'nonce-client'" },
  });
  const response = await worker.fetch(request, env, context);
  const csp = response.headers.get("Content-Security-Policy");
  assert(csp);
  expect(csp).not.toContain("'nonce-client'");
  const directives = new Map(
    csp.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values];
    }),
  );

  expect(directives.get("default-src")).toEqual(["'none'"]);
  expect(directives.get("script-src")).toEqual([
    "'self'",
    expect.stringMatching(/^'nonce-[A-Za-z0-9+/]+=*'$/),
  ]);
  expect(directives.get("style-src")).toEqual(directives.get("script-src"));
  expect(directives.get("style-src-attr")).toEqual(["'unsafe-inline'"]);
  expect(directives.get("base-uri")).toEqual(["'none'"]);
  expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  expect(directives.get("connect-src")).toEqual([
    "'self'",
    "https://api.tailos.example",
    "wss://api.tailos.example",
  ]);
  expect(directives.get("form-action")).toEqual([
    "'self'",
    "https://api.tailos.example",
    "https://github.com",
  ]);
  expect(render.mock.calls[0][0].headers.get("Content-Security-Policy")).toBe(
    csp,
  );
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("<h1>Tailos</h1>");

  const next = await worker.fetch(request, env, context);
  expect(next.headers.get("Content-Security-Policy")).not.toBe(csp);
});

test("preserves the health route response", async () => {
  const health = Response.json({ status: "ok", service: "tailos-web" });
  render.mockResolvedValueOnce(health);

  const response = await worker.fetch(
    new Request("https://tailos.example/health"),
    env,
    context,
  );

  expect(response).toBe(health);
});

test("proxies the OAuth callback on the stable Web host to its deployed API", async () => {
  config.isPreview = true;
  const response = new Response(null, {
    status: 303,
    headers: { Location: "https://api.tailos.example/login" },
  });
  const upstreamFetch = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal("fetch", upstreamFetch);
  const bindings = {
    ...env,
    TAILOS_PREVIEW_API_ORIGIN: "https://deployment-pr-123.preview-api.example",
    TAILOS_PREVIEW_PROXY_SECRET: "test-proxy-secret",
  };
  const path = "/v1/auth/callback/github?state=state&code=code";
  const request = new Request(`https://api.tailos.example${path}`, {
    headers: {
      Cookie: "oauth_state=state",
      "X-Tailos-Preview-Proxy": "ignored",
    },
  });
  expect(await worker.fetch(request, bindings, context)).toBe(response);
  const [target, init] = upstreamFetch.mock.calls[0];
  assert(target instanceof Request);
  expect(target.url).toBe(bindings.TAILOS_PREVIEW_API_ORIGIN + path);
  expect(init?.redirect).toBe("manual");
  expect(new Headers(init?.headers).get("Cookie")).toBe("oauth_state=state");
  expect(new Headers(init?.headers).get("X-Tailos-Preview-Proxy")).toBe(
    "test-proxy-secret",
  );
  expect(render).not.toHaveBeenCalled();
  expect(
    (
      await worker.fetch(
        new Request(`https://other.example${path}`),
        bindings,
        context,
      )
    ).status,
  ).toBe(404);
  expect(upstreamFetch).toHaveBeenCalledTimes(1);
});

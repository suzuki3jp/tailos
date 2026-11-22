import { afterEach, assert, expect, test, vi } from "vitest";
import worker from "@/worker/index.ts";

const render = vi.hoisted(() =>
  vi.fn<(request: Request) => Promise<Response>>(),
);

vi.mock("vinext/server/fetch-handler", () => ({ default: { fetch: render } }));
vi.mock("@/shared/config", () => ({
  apiOrigin: "https://tailos.app",
  usesWebApiProxy: true,
}));

const env = { ASSETS: { fetch: vi.fn(), connect: vi.fn() } };
// The mocked renderer never reads the platform context.
const context = {} as ExecutionContext;

afterEach(() => {
  vi.unstubAllEnvs();
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
    "https://tailos.app",
    "wss://tailos.app",
  ]);
  expect(directives.get("form-action")).toEqual([
    "'self'",
    "https://tailos.app",
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

test("passes the original API request and OAuth redirect through the service binding", async () => {
  const redirect = new Response(null, {
    status: 303,
    headers: { Location: "https://github.com/login/oauth/authorize" },
  });
  redirect.headers.append("Set-Cookie", "one=1; Path=/");
  redirect.headers.append("Set-Cookie", "two=2; Path=/");
  const fetch = vi.fn().mockResolvedValue(redirect);
  const request = new Request(
    "https://tailos.app/api/v1/auth/login?flow=github",
    {
      method: "POST",
      headers: {
        Origin: "https://tailos.app",
        Cookie: "__Host-tailos.session_token=new",
      },
      body: "form=value",
    },
  );

  const result = await worker.fetch(
    request,
    { ...env, BROWSER_API: { fetch, connect: vi.fn() } },
    context,
  );
  expect(result).toBe(redirect);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(request, {
    redirect: "manual",
  });
  expect(render).not.toHaveBeenCalled();
});

test("does not forward the API prefix on an unexpected host or a lookalike path", async () => {
  const fetch = vi.fn();
  const bindings = { ...env, BROWSER_API: { fetch, connect: vi.fn() } };
  render.mockResolvedValueOnce(new Response(null, { status: 404 }));

  expect(
    (
      await worker.fetch(
        new Request("https://another.example/api/v1/account"),
        bindings,
        context,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await worker.fetch(
        new Request("https://tailos.app/api/v10/account"),
        bindings,
        context,
      )
    ).status,
  ).toBe(404);
  expect(render).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

test("expires the old shared cookie on production pages", async () => {
  render.mockResolvedValueOnce(
    new Response("<h1>Tailos</h1>", {
      headers: { "Content-Type": "text/html" },
    }),
  );
  const response = await worker.fetch(
    new Request("https://tailos.app/login", {
      headers: { Cookie: "other=1; __Secure-tailos.session_token=old" },
    }),
    env,
    context,
  );

  expect(response.headers.getSetCookie()).toEqual([
    "__Secure-tailos.session_token=; Max-Age=0; Path=/; Domain=tailos.app; HttpOnly; Secure; SameSite=Lax",
  ]);
});

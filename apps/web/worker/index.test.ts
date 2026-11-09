import { afterEach, assert, expect, test, vi } from "vitest";
import worker from "./index.ts";

const render = vi.hoisted(() =>
  vi.fn<(request: Request) => Promise<Response>>(),
);

vi.mock("vinext/server/fetch-handler", () => ({ default: { fetch: render } }));
vi.mock("../api-origin.ts", () => ({
  apiOrigin: "https://api.meguri.example",
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
      new Response("<h1>Meguri</h1>", {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  );
  const request = new Request("https://meguri.example/login", {
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
  expect(directives.get("base-uri")).toEqual(["'none'"]);
  expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  expect(directives.get("connect-src")).toEqual([
    "'self'",
    "https://api.meguri.example",
  ]);
  expect(directives.get("form-action")).toEqual([
    "'self'",
    "https://api.meguri.example",
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
  expect(await response.text()).toBe("<h1>Meguri</h1>");

  const next = await worker.fetch(request, env, context);
  expect(next.headers.get("Content-Security-Policy")).not.toBe(csp);
});

test("preserves the health route response", async () => {
  const health = Response.json({ status: "ok", service: "meguri-web" });
  render.mockResolvedValueOnce(health);

  const response = await worker.fetch(
    new Request("https://meguri.example/health"),
    env,
    context,
  );

  expect(response).toBe(health);
});

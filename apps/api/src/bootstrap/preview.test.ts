import { assert, expect, test, vi } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { testLoginBindings } from "@/infrastructure/auth/testing.ts";
import preview from "./preview.ts";

test("uses the Web origin for GitHub OAuth and accepts only the authorized proxy and PR session", async (t) => {
  const DB = await createTestDb(t);
  const web = "https://pr-123.preview.tailos.app";
  const env = {
    ...testLoginBindings(DB),
    TAILOS_PUBLIC_ORIGIN: web,
    TAILOS_WEB_ORIGIN: web,
    TAILOS_BROWSER_API_VIA_WEB: "true",
    TAILOS_PREVIEW: "true" as const,
    TAILOS_PREVIEW_PROXY_SECRET: "test-only-proxy-secret",
  };
  const upstream = "https://a1b2c3d4-pr-123.preview-api.tailos.app";
  const proxy = { "X-Tailos-Preview-Proxy": env.TAILOS_PREVIEW_PROXY_SECRET };
  // The routes in this test do not use the Worker execution context.
  const ctx = {} as ExecutionContext;
  const request = (path: string, init?: RequestInit) =>
    preview.fetch(new Request(upstream + path, init), env, ctx);
  expect((await request("/api/v1/account")).status).toBe(404);
  expect((await request("/v1/account", { headers: proxy })).status).toBe(404);
  expect((await request("/webhooks/github", { headers: proxy })).status).toBe(
    404,
  );
  expect(
    (
      await request("/api/v1/auth/login", {
        method: "POST",
        headers: { ...proxy, Origin: "https://pr-124.preview.tailos.app" },
      })
    ).status,
  ).toBe(403);

  const login = await request("/api/v1/auth/login", {
    method: "POST",
    headers: { ...proxy, Origin: web },
  });
  expect(login.status).toBe(303);
  const location = login.headers.get("Location");
  assert(location);
  const authorize = new URL(location);
  expect(authorize.origin + authorize.pathname).toBe(
    "https://github.com/login/oauth/authorize",
  );
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    `${web}/api/v1/auth/callback/github`,
  );
  expect(login.headers.get("Set-Cookie")).toMatch(/HttpOnly/i);
  expect(login.headers.get("Set-Cookie")).not.toMatch(/Domain=/i);

  const fetch = globalThis.fetch;
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({
          access_token: "test-token",
          token_type: "bearer",
        });
      if (url === "https://api.github.com/user")
        return Response.json({
          id: 123,
          login: "operator",
          name: "Operator",
          email: "operator@example.test",
        });
      if (url === "https://api.github.com/user/emails")
        return Response.json([
          { email: "operator@example.test", primary: true, verified: true },
        ]);
      return fetch(input, init);
    });
  t.onTestFinished(() => mock.mockRestore());
  const state = authorize.searchParams.get("state");
  assert(state);
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((line) => line.split(";", 1)[0])
      .join("; ");
  const callback = await request(
    "/api/v1/auth/callback/github?" +
      new URLSearchParams({ state, code: "test-code" }),
    { headers: { ...proxy, Cookie: cookies(login) } },
  );
  expect(callback.headers.get("Location")).toBe(web + "/login");
  expect(callback.headers.getSetCookie()).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^__Host-tailos-preview\.session_token=.+HttpOnly/),
    ]),
  );
  expect(callback.headers.get("Set-Cookie")).not.toMatch(/Domain=/i);
  const account = new Request(upstream + "/api/v1/account", {
    headers: { ...proxy, Cookie: cookies(callback) },
  });
  expect((await preview.fetch(account, env, ctx)).status).toBe(200);
  expect(
    (
      await preview.fetch(
        account,
        {
          ...env,
          BETTER_AUTH_SECRET: "different-preview-32-character-signing-secret",
        },
        ctx,
      )
    ).status,
  ).toBe(401);
});

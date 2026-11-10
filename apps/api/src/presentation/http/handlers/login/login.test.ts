import { assert, expect, test, vi } from "vitest";
import { createTestDb } from "#api/infrastructure/d1/testing.ts";
import app from "#api/bootstrap/http.ts";
import {
  createLoginAuth,
  findOperatorUserId,
} from "#api/infrastructure/auth/login.ts";

test("GitHub login authenticates the configured account and persists only the Tailos session", async (t) => {
  const DB = await createTestDb(t);
  const origin = "https://api.tailos.example";
  const webOrigin = "https://tailos.example";
  const env = {
    DB,
    TAILOS_PUBLIC_ORIGIN: origin,
    TAILOS_WEB_ORIGIN: webOrigin,
    BETTER_AUTH_SECRET: "test-only-47-characters-of-random-looking-value",
    TAILOS_GITHUB_OAUTH_CLIENT_ID: "test-client",
    TAILOS_GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    TAILOS_OPERATOR_GITHUB_ID: "123",
  };
  const callback = origin + "/api/auth/callback/github";
  const fetch = globalThis.fetch;
  let githubId = 999;
  let exchanges = 0;
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        exchanges++;
        const body = new URLSearchParams(String(init?.body));
        assert(body.get("code_verifier"));
        return Response.json({
          access_token: "github-token",
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({
          id: githubId,
          login: "operator",
          name: "Operator",
          email: null,
        });
      }
      if (url === "https://api.github.com/user/emails") {
        return Response.json([
          { email: "operator@example.test", primary: true, verified: true },
        ]);
      }
      return fetch(input, init);
    });
  t.onTestFinished(() => {
    mock.mockRestore();
  });

  const cookieHeader = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((line) => line.split(";", 1)[0])
      .join("; ");
  const request = (path: string, init?: RequestInit) =>
    app.request(origin + path, init, env);
  const start = async () => {
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { Origin: webOrigin },
    });
    expect(response.status, await response.clone().text()).toBe(303);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const url = new URL(response.headers.get("Location") ?? "");
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("redirect_uri")).toBe(callback);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state");
    assert(state);
    const cookie = cookieHeader(response);
    assert(cookie);
    return { state, cookie };
  };
  const finish = ({ state, cookie }: Awaited<ReturnType<typeof start>>) =>
    app.request(
      callback + "?" + new URLSearchParams({ state, code: "test-code" }),
      { headers: { Cookie: cookie } },
      env,
    );

  expect((await app.request(origin + "/login")).status).toBe(404);
  expect(
    (
      await request("/api/auth/login", {
        method: "POST",
        headers: { Origin: "null" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/auth/login", {
        method: "POST",
        headers: { Origin: "https://other.example" },
      })
    ).status,
  ).toBe(403);
  const wrongState = await start();
  await finish({ ...wrongState, state: "wrong" });
  expect(exchanges).toBe(0);

  const denied = await finish(await start());
  expect(denied.headers.get("Location") ?? "").toMatch(/error=/);
  expect(await findOperatorUserId(env)).toBe(null);
  expect(await DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(
    0,
  );

  githubId = 123;
  const login = await start();
  const granted = await finish(login);
  expect(granted.headers.get("Location")).toBe(webOrigin + "/login");
  expect(granted.headers.get("Cache-Control")).toBe("private, no-store");
  const sessionCookie = cookieHeader(granted);
  const account = await request("/api/account", {
    headers: { Cookie: sessionCookie, Origin: webOrigin },
  });
  expect(account.status).toBe(200);
  expect(await account.json()).toStrictEqual({ connectEnabled: false });
  expect(account.headers.get("Access-Control-Allow-Origin")).toBe(webOrigin);
  expect(account.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  assert(
    granted.headers
      .getSetCookie()
      .some(
        (line) =>
          line.includes("session_token") &&
          line.includes("HttpOnly") &&
          line.includes("Secure") &&
          !line.includes("Domain="),
      ),
  );
  const auth = createLoginAuth(env);
  assert(auth);
  const current = await auth.api.getSession({
    headers: new Headers({ Cookie: sessionCookie }),
  });
  assert(current);
  expect(current.user.id).toBe(await findOperatorUserId(env));
  expect(current.user.id).toMatch(/^[\da-f-]{36}$/);
  expect(
    await DB.prepare(
      "SELECT account_id, access_token, refresh_token FROM auth_accounts",
    ).first(),
  ).toStrictEqual({
    account_id: "123",
    access_token: null,
    refresh_token: null,
  });
  expect((await finish(login)).headers.get("Location") ?? "").toMatch(/error=/);

  expect(
    (
      await request("/api/auth/logout", {
        method: "POST",
        headers: { Origin: "https://other.example", Cookie: sessionCookie },
      })
    ).status,
  ).toBe(403);
  const logout = await request("/api/auth/logout", {
    method: "POST",
    headers: { Origin: webOrigin, Cookie: sessionCookie },
  });
  expect(logout.status).toBe(303);
  expect(logout.headers.get("Location")).toBe(webOrigin + "/login");
  expect(logout.headers.get("Cache-Control")).toBe("private, no-store");
  expect(
    await auth.api.getSession({
      headers: new Headers({ Cookie: sessionCookie }),
    }),
  ).toBe(null);
});

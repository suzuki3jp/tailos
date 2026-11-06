import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createTestDb } from "../db/testing.ts";
import app from "../index.ts";
import { createLoginAuth, findOperatorUserId } from "./login.ts";

test("GitHub login authenticates the configured account and persists only the Meguri session", async (t) => {
  const DB = await createTestDb(t);
  const origin = "https://meguri.example";
  const env = {
    DB,
    MEGURI_PUBLIC_ORIGIN: origin,
    BETTER_AUTH_SECRET: "test-only-47-characters-of-random-looking-value",
    MEGURI_GITHUB_OAUTH_CLIENT_ID: "test-client",
    MEGURI_GITHUB_OAUTH_CLIENT_SECRET: "test-secret",
    MEGURI_OPERATOR_GITHUB_ID: "123",
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
        assert.ok(body.get("code_verifier"));
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
    const response = await request("/login", {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.equal(response.status, 303, await response.clone().text());
    const url = new URL(response.headers.get("Location") ?? "");
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.searchParams.get("redirect_uri"), callback);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const state = url.searchParams.get("state");
    assert.ok(state);
    const cookie = cookieHeader(response);
    assert.ok(cookie);
    return { state, cookie };
  };
  const finish = ({ state, cookie }: Awaited<ReturnType<typeof start>>) =>
    app.request(
      callback + "?" + new URLSearchParams({ state, code: "test-code" }),
      { headers: { Cookie: cookie } },
      env,
    );

  assert.equal((await app.request(origin + "/login")).status, 404);
  assert.equal(
    (
      await request("/login", {
        method: "POST",
        headers: { Origin: "https://other.example" },
      })
    ).status,
    403,
  );
  const wrongState = await start();
  await finish({ ...wrongState, state: "wrong" });
  assert.equal(exchanges, 0);

  const denied = await finish(await start());
  assert.match(denied.headers.get("Location") ?? "", /error=/);
  assert.equal(await findOperatorUserId(env), null);
  assert.equal(
    await DB.prepare("SELECT COUNT(*) AS n FROM users").first("n"),
    0,
  );

  githubId = 123;
  const login = await start();
  const granted = await finish(login);
  assert.equal(granted.headers.get("Location"), "/login");
  const sessionCookie = cookieHeader(granted);
  assert.ok(
    granted.headers
      .getSetCookie()
      .some(
        (line) =>
          line.includes("session_token") &&
          line.includes("HttpOnly") &&
          line.includes("Secure"),
      ),
  );
  const auth = createLoginAuth(env);
  assert.ok(auth);
  const current = await auth.api.getSession({
    headers: new Headers({ Cookie: sessionCookie }),
  });
  assert.ok(current);
  assert.equal(current.user.id, await findOperatorUserId(env));
  assert.match(current.user.id, /^[\da-f-]{36}$/);
  assert.deepEqual(
    await DB.prepare(
      "SELECT account_id, access_token, refresh_token FROM auth_accounts",
    ).first(),
    { account_id: "123", access_token: null, refresh_token: null },
  );
  assert.match((await finish(login)).headers.get("Location") ?? "", /error=/);

  assert.equal(
    (
      await request("/logout", {
        method: "POST",
        headers: { Origin: "https://other.example", Cookie: sessionCookie },
      })
    ).status,
    403,
  );
  const logout = await request("/logout", {
    method: "POST",
    headers: { Origin: origin, Cookie: sessionCookie },
  });
  assert.equal(logout.status, 303);
  assert.equal(
    await auth.api.getSession({
      headers: new Headers({ Cookie: sessionCookie }),
    }),
    null,
  );
});

import { expect, test } from "vitest";
import app from "@/bootstrap/http.ts";

test("the Worker serves the health endpoint", async () => {
  const response = await app.request("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    status: "ok",
    service: "tailos-api",
  });
});

test("runner smoke does not allocate a container without a configured bearer token", async () => {
  const request = { method: "POST" };
  const path = "/_internal/runner/health";
  expect((await app.request(path, request)).status).toBe(404);
  expect(
    (await app.request(path, request, { TAILOS_TEST_TOKEN: "test-token" }))
      .status,
  ).toBe(401);
  expect(
    (
      await app.request(
        path,
        { ...request, headers: { Authorization: "Bearer test-token" } },
        { TAILOS_TEST_TOKEN: "test-token" },
      )
    ).status,
  ).toBe(503);
});

const origin = "https://tailos.example";
const env = {
  TAILOS_WEB_ORIGIN: origin,
  TAILOS_PUBLIC_ORIGIN: "https://api.tailos.example",
  BETTER_AUTH_SECRET: "test-secret",
};

test("v1 browser routes retain authentication and credentialed CORS", async () => {
  for (const path of [
    "account",
    "projects",
    "sessions",
    "connect",
    "mcp-keys",
    "diagnostics/traces",
  ]) {
    const response = await app.request(
      `https://api.tailos.example/v1/${path}`,
      { headers: { Origin: origin } },
      env,
    );
    expect(response.status, path).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
  }
});

test("the old API prefix is no longer routed", async () => {
  for (const path of ["account", "projects", "sessions", "auth/login"]) {
    const response = await app.request(
      `https://api.tailos.example/api/${path}`,
      { method: path === "auth/login" ? "POST" : "GET" },
      env,
    );
    expect(response.status, path).toBe(404);
  }
});

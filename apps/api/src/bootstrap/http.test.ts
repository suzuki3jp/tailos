import { expect, test } from "vitest";
import app from "./http.ts";

test("the Worker serves the health endpoint", async () => {
  const response = await app.request("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    status: "ok",
    service: "meguri-api",
  });
});

test("runner smoke does not allocate a container without a configured bearer token", async () => {
  const request = { method: "POST" };
  const path = "/_internal/runner/health";
  expect((await app.request(path, request)).status).toBe(404);
  expect(
    (await app.request(path, request, { MEGURI_TEST_TOKEN: "test-token" }))
      .status,
  ).toBe(401);
  expect(
    (
      await app.request(
        path,
        { ...request, headers: { Authorization: "Bearer test-token" } },
        { MEGURI_TEST_TOKEN: "test-token" },
      )
    ).status,
  ).toBe(503);
});

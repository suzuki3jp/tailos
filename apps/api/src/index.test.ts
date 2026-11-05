import assert from "node:assert/strict";
import { test } from "node:test";
import app from "./index.ts";

test("the Worker serves the health endpoint", async () => {
  const response = await app.request("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("runner smoke does not allocate a container without a configured bearer token", async () => {
  const request = { method: "POST" };
  const path = "/_internal/runner/health";
  assert.equal((await app.request(path, request)).status, 404);
  assert.equal(
    (await app.request(path, request, { MEGURI_TEST_TOKEN: "test-token" }))
      .status,
    401,
  );
  assert.equal(
    (
      await app.request(
        path,
        { ...request, headers: { Authorization: "Bearer test-token" } },
        { MEGURI_TEST_TOKEN: "test-token" },
      )
    ).status,
    503,
  );
});

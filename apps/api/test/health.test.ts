import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../src/index.ts";

test("the Worker serves the health endpoint", async () => {
  const response = await app.request("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

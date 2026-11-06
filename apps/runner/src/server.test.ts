import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "vitest";
import { createRunnerServer } from "./server.ts";

test("serves only the runner health endpoint", async (t) => {
  const server = createRunnerServer();
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "runner" });
  assert.equal(
    (await fetch(`${origin}/health`, { method: "POST" })).status,
    404,
  );
  assert.equal((await fetch(`${origin}/`)).status, 404);
});

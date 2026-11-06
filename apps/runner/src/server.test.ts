import { once } from "node:events";
import { assert, expect, test } from "vitest";
import { createRunnerServer } from "./server.ts";

test("serves only the runner health endpoint", async (t) => {
  const server = createRunnerServer();
  t.onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${origin}/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toStrictEqual({
    status: "ok",
    service: "runner",
  });
  expect((await fetch(`${origin}/health`, { method: "POST" })).status).toBe(
    404,
  );
  expect((await fetch(`${origin}/`)).status).toBe(404);
});

import { expect, test, vi } from "vitest";
import { createRunRoutes } from "./runs.ts";

const id = "aabff0c8-dc59-49b7-9598-19f5be8f5f56";
const run = { id, status: "queued", errorCode: null };
const env = { MEGURI_TEST_TOKEN: "test-token" };
const request = {
  method: "POST",
  headers: { Authorization: "Bearer test-token" },
};

test("starts an owned Run through the injected operation without a DO binding", async () => {
  const start = vi.fn(async () => "succeeded");
  const find = vi.fn(async () => run);
  const routes = createRunRoutes(() => start, find);
  const response = await routes.request(`/${id}/start`, request, env);
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    runId: id,
    status: "succeeded",
  });
  expect(find).toHaveBeenCalledWith(env, id, "internal-smoke");
  expect(start).toHaveBeenCalledExactlyOnceWith(id);
});

test("authenticates and checks ownership before resolving the start operation", async () => {
  const starter = vi.fn();
  const find = vi.fn(async () => null);
  const routes = createRunRoutes(starter, find);
  expect((await routes.request(`/${id}/start`, request)).status).toBe(404);
  expect(
    (await routes.request(`/${id}/start`, { method: "POST" }, env)).status,
  ).toBe(401);
  expect(find).not.toHaveBeenCalled();
  expect((await routes.request("/invalid/start", request, env)).status).toBe(
    404,
  );
  expect(find).not.toHaveBeenCalled();
  expect((await routes.request(`/${id}/start`, request, env)).status).toBe(404);
  expect(starter).not.toHaveBeenCalled();
});

test("returns 503 if an owned Run has no start operation", async () => {
  const routes = createRunRoutes(
    () => undefined,
    async () => run,
  );
  const response = await routes.request(`/${id}/start`, request, env);
  expect(response.status).toBe(503);
  expect(await response.json()).toStrictEqual({ error: "runner_unavailable" });
});

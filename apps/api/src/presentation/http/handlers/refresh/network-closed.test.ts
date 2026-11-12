import { expect, test, vi } from "vitest";
import { createRefreshRoutes } from "@/presentation/http/handlers/refresh/refresh.ts";

test("network closure requires an active run and Runner lease, and fails closed", async () => {
  const runId = crypto.randomUUID();
  const bearer = "a".repeat(64);
  const active = vi.fn().mockResolvedValue(true);
  const close = vi.fn().mockResolvedValue(true);
  const getByName = vi.fn().mockReturnValue({ closeDependencyNetwork: close });
  const app = createRefreshRoutes(active);
  const request = (authorization = `Bearer ${bearer}`, id: string = runId) =>
    app.request(
      `/${id}/network-closed`,
      {
        method: "POST",
        headers: { Authorization: authorization },
      },
      { RUNNER: { getByName } },
    );
  expect((await request("invalid")).status).toBe(401);
  expect((await request(`Bearer ${bearer}`, "invalid")).status).toBe(401);
  expect(close).not.toHaveBeenCalled();
  active.mockResolvedValueOnce(false);
  expect((await request()).status).toBe(401);
  expect(close).not.toHaveBeenCalled();
  close.mockResolvedValueOnce(false);
  expect((await request()).status).toBe(401);
  const result = await request();
  expect(result.status).toBe(204);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect(getByName).toHaveBeenCalledWith(runId);
  expect(close).toHaveBeenCalledWith(runId, bearer);
  close.mockRejectedValueOnce(new Error("intercept failed"));
  expect((await request()).status).toBe(503);
});

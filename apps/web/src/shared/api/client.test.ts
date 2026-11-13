import { afterEach, expect, test, vi } from "vitest";
import { api } from "./client";
import { apiOrigin } from "../config";

afterEach(() => vi.unstubAllGlobals());

test("keeps credentialed cross-origin requests and cancellation signals", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  await api.account.$get(undefined, { init: { signal: controller.signal } });
  expect(fetch).toHaveBeenCalledWith(
    new URL("/api/account", apiOrigin).href,
    expect.objectContaining({
      credentials: "include",
      signal: controller.signal,
    }),
  );
});

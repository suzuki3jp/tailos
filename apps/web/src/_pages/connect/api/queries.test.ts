import { QueryClient } from "@tanstack/react-query";
import { afterEach, assert, expect, test, vi } from "vitest";
import { connectionQueryOptions } from "./queries";

afterEach(() => vi.unstubAllGlobals());

test("polls pending connections every five seconds and stops for other states", async () => {
  for (const state of [
    "pending",
    "connected",
    "disconnected",
    "expired",
    "failed",
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ state })));
    const client = new QueryClient();
    try {
      const options = connectionQueryOptions();
      const query = client.getQueryCache().build(client, {
        ...options,
        queryKey: [...options.queryKey],
      });
      await query.fetch();
      assert(typeof options.refetchInterval === "function");
      expect(options.refetchInterval(query)).toBe(
        state === "pending" ? 5000 : false,
      );
    } finally {
      client.clear();
    }
  }
});

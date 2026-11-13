import { QueryClient } from "@tanstack/react-query";
import { afterEach, assert, expect, test, vi } from "vitest";
import { sessionQueryOptions } from "./queries";

afterEach(() => vi.unstubAllGlobals());

test("polls sessions with active runs and stops when all runs finish", async () => {
  for (const statuses of [
    [],
    ["queued"],
    ["running"],
    ["succeeded", "failed"],
    ["failed", "running"],
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          runs: statuses.map((status) => ({ status })),
        }),
      ),
    );
    const client = new QueryClient();
    try {
      const options = sessionQueryOptions("session-1");
      const query = client.getQueryCache().build(client, {
        ...options,
        queryKey: [...options.queryKey],
      });
      await query.fetch();
      expect(options.queryKey).toEqual(["sessions", "session-1"]);
      assert(typeof options.refetchInterval === "function");
      expect(options.refetchInterval(query)).toBe(
        statuses.some((status) => ["queued", "running"].includes(status))
          ? 5000
          : false,
      );
    } finally {
      client.clear();
    }
  }
});

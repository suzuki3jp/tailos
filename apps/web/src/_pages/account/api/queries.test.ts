import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { accountQueryOptions } from "./queries";

afterEach(() => vi.unstubAllGlobals());

test("treats 401 as logged out and preserves other response errors", async () => {
  for (const status of [401, 404, 503]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status })),
    );
    const client = new QueryClient();
    try {
      expect(await client.fetchQuery(accountQueryOptions())).toEqual(
        status === 401 ? null : { error: status },
      );
    } finally {
      client.clear();
    }
  }
});

import { QueryClient } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { routineSessionsQueryOptions } from "./routine-sessions";

// The Session public API also exports its row, whose Link is provided by Vinext.
vi.mock("next/link", () => ({ default: () => null }));

test("requests only the ten most recent Sessions scoped to the Routine", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({ items: [], nextCursor: null }),
  );
  vi.stubGlobal("fetch", http);
  const cache = new QueryClient();
  try {
    await cache.fetchQuery(routineSessionsQueryOptions("p1", "routine-1"));
    expect(http).toHaveBeenCalledTimes(1);
    const url = new URL(String(http.mock.calls[0]?.[0]));
    expect(url.pathname).toMatch(/\/projects\/p1\/sessions$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "10",
      routineId: "routine-1",
    });
  } finally {
    cache.clear();
    vi.unstubAllGlobals();
  }
});

import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { dehydrateApiQueries } from "./dehydrate.server";

const description = { name: "ReadError", message: "Data unavailable." };

test("keeps completed results and only exposes the public description of failed queries", async () => {
  const cache = new QueryClient();
  const failure = Object.assign(new Error("private response body"), {
    status: 401,
    headers: { cookie: "private" },
  });
  cache.setQueryData(["ready"], { item: "saved" });
  cache.getQueryCache().build(cache, { queryKey: ["pending"] });
  await cache.prefetchQuery({
    queryKey: ["failure"],
    queryFn: () => Promise.reject(failure),
  });

  try {
    const { queries } = dehydrateApiQueries(cache, description);
    expect(queries.map((query) => query.queryKey)).toEqual([
      ["ready"],
      ["failure"],
    ]);
    expect(queries[0]?.state.data).toEqual({ item: "saved" });
    const error = { ...description, status: 401 };
    expect(queries[1]?.state).toMatchObject({
      status: "error",
      error,
      fetchFailureReason: error,
    });
    expect(queries[1]?.state.error).toStrictEqual(error);
    expect(queries[1]?.state.fetchFailureReason).toStrictEqual(error);
    expect(cache.getQueryState(["failure"])?.error).toBe(failure);
    expect(JSON.stringify(queries)).not.toContain("private");
  } finally {
    cache.clear();
  }
});

test("can preserve an omitted or null status for errors without an HTTP status", async () => {
  const cache = new QueryClient();
  await cache.prefetchQuery({
    queryKey: ["failure"],
    queryFn: () => Promise.reject({ status: "404", reason: "private" }),
  });
  try {
    expect(
      dehydrateApiQueries(cache, description).queries[0]?.state.error,
    ).toStrictEqual(description);
    expect(
      dehydrateApiQueries(cache, { ...description, missingStatus: null })
        .queries[0]?.state.error,
    ).toStrictEqual({ ...description, status: null });
  } finally {
    cache.clear();
  }
});

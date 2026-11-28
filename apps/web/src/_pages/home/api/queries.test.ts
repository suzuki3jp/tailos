import { projectsQueryOptions } from "@/features/select-project";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import {
  AccountSessionsError,
  accountSessionsQueryOptions,
} from "@/entities/session";

// The Session entity also exports its row, which links with next/link.
vi.mock("next/link", () => ({ default: () => null }));
afterEach(() => vi.unstubAllGlobals());
function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

test("project choices follow every cursor and retain IDs, names, and repositories", async () => {
  const first = { id: "p1", name: "Alpha", repository: "owner/first" };
  const second = { id: "p2", name: "Alpha", repository: "owner/second" };
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/v1/projects");
    expect(init).toMatchObject({
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
    expect(url.searchParams.has("limit")).toBe(false);
    return Response.json(
      url.searchParams.has("cursor")
        ? { items: [second], nextCursor: null }
        : { items: [first], nextCursor: "project_cursor" },
    );
  });
  vi.stubGlobal("fetch", http);
  const client = queryClient();
  try {
    expect(await client.fetchQuery(projectsQueryOptions())).toEqual([
      first,
      second,
    ]);
    expect(http).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(http.mock.calls[1]?.[0])).searchParams.get("cursor"),
    ).toBe("project_cursor");
  } finally {
    client.clear();
  }
});

test.each([
  { cursors: ["first", "first"] },
  { cursors: ["first", "second", "first"] },
])("project loading rejects a cursor cycle ($cursors)", async ({ cursors }) => {
  let page = 0;
  const http = vi.fn<typeof fetch>(async () => {
    if (page >= cursors.length) throw new Error("Unexpected page request");
    return Response.json({ items: [], nextCursor: cursors[page++] });
  });
  vi.stubGlobal("fetch", http);
  const client = queryClient();
  try {
    await expect(client.fetchQuery(projectsQueryOptions())).rejects.toThrow(
      "Invalid projects pagination",
    );
    expect(http).toHaveBeenCalledTimes(cursors.length);
    expect(
      client.getQueryData(projectsQueryOptions().queryKey),
    ).toBeUndefined();
  } finally {
    client.clear();
  }
});

test("session pagination keeps existing rows after a next-page failure and retries the same cursor", async () => {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ items: [{ id: "s1" }], nextCursor: "session_cursor" }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({ items: [{ id: "s2" }], nextCursor: null }),
    );
  vi.stubGlobal("fetch", http);
  const client = queryClient();
  const observer = new InfiniteQueryObserver(
    client,
    accountSessionsQueryOptions(),
  );
  try {
    await observer.refetch();
    const failed = await observer.fetchNextPage();
    expect(failed.isFetchNextPageError).toBe(true);
    expect(failed.error).toMatchObject({ status: 503 });
    expect(failed.data?.pages).toHaveLength(1);
    const retried = await observer.fetchNextPage();
    expect(retried.data?.pages.flatMap((page) => page.items)).toEqual([
      { id: "s1" },
      { id: "s2" },
    ]);
    expect(retried.hasNextPage).toBe(false);
    expect(
      new URL(String(http.mock.calls[0]?.[0])).searchParams.has("cursor"),
    ).toBe(false);
    for (const call of http.mock.calls.slice(1)) {
      expect(new URL(String(call[0])).searchParams.get("cursor")).toBe(
        "session_cursor",
      );
      expect(call[1]).toMatchObject({
        credentials: "include",
        signal: expect.any(AbortSignal),
      });
    }
  } finally {
    observer.destroy();
    client.clear();
  }
});

test.each([401, 403, 503])(
  "list queries preserve HTTP %i instead of treating it as an empty list",
  async (status) => {
    const http = vi.fn<typeof fetch>(
      async () => new Response(null, { status }),
    );
    vi.stubGlobal("fetch", http);
    const client = queryClient();
    try {
      await expect(
        client.fetchQuery(projectsQueryOptions()),
      ).rejects.toMatchObject({ status });
      await expect(
        client.fetchInfiniteQuery(accountSessionsQueryOptions()),
      ).rejects.toBeInstanceOf(AccountSessionsError);
      expect(http).toHaveBeenCalledTimes(2);
    } finally {
      client.clear();
    }
  },
);

test("cancelling project loading aborts the credentialed request", async () => {
  const http = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  vi.stubGlobal("fetch", http);
  const client = queryClient();
  try {
    const pending = client.fetchQuery(projectsQueryOptions());
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1));
    await client.cancelQueries({ queryKey: ["projects", "account-list"] });
    await rejected;
    expect(http.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  } finally {
    client.clear();
  }
});

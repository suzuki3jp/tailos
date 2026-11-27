import { infiniteQueryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/shared/api";

export type AccountSession = InferResponseType<
  typeof api.sessions.$get,
  200
>["items"][number];

export class AccountSessionsError extends Error {
  constructor(public readonly status: number) {
    super(`Request failed (${status})`);
  }
}

/** The account's Sessions, most recently updated first. */
export function accountSessionsQueryOptions(client = api) {
  return infiniteQueryOptions({
    queryKey: ["sessions", "account-list"],
    refetchOnMount: false,
    retryOnMount: false,
    initialPageParam: "",
    queryFn: async ({ signal, pageParam }) => {
      const response = await client.sessions.$get(
        { query: pageParam ? { cursor: pageParam } : {} },
        { init: { signal } },
      );
      if (!response.ok) throw new AccountSessionsError(response.status);
      const page = await response.json();
      if (!("items" in page)) throw new Error("Invalid sessions response");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** Sessions across the loaded pages, without repeats, up to `limit`. */
export function uniqueSessions(
  pages: readonly { items: readonly AccountSession[] }[] | undefined,
  limit: number,
) {
  const byId = new Map<string, AccountSession>();
  for (const page of pages ?? []) {
    for (const session of page.items) {
      if (!byId.has(session.id)) byId.set(session.id, session);
    }
  }
  return Array.from(byId.values()).slice(0, limit);
}

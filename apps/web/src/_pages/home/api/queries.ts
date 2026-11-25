import { infiniteQueryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/shared/api";

export type HomeSession = InferResponseType<
  typeof api.sessions.$get,
  200
>["items"][number];

export class HomeRequestError extends Error {
  constructor(public readonly status: number) {
    super(`Request failed (${status})`);
  }
}

export function requestErrorStatus(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

export function homeSessionsQueryOptions(client = api) {
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
      if (!response.ok) throw new HomeRequestError(response.status);
      const page = await response.json();
      if (!("items" in page)) throw new Error("Invalid sessions response");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

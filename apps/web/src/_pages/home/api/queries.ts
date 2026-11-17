import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/shared/api";

export type HomeProject = InferResponseType<
  typeof api.projects.$get,
  200
>["items"][number];
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

export function homeProjectsQueryOptions(client = api) {
  return queryOptions({
    queryKey: ["projects", "account-list"],
    refetchOnMount: false,
    retryOnMount: false,
    queryFn: async ({ signal }) => {
      const projects = new Map<string, HomeProject>();
      let cursor: string | null = null;
      do {
        const response = await client.projects.$get(
          { query: cursor === null ? {} : { cursor } },
          { init: { signal } },
        );
        if (!response.ok) throw new HomeRequestError(response.status);
        const page = await response.json();
        for (const project of page.items) projects.set(project.id, project);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return Array.from(projects.values());
    },
  });
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

import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/shared/api";

export type SelectableProject = InferResponseType<
  typeof api.projects.$get,
  200
>["items"][number];

class ProjectRequestError extends Error {
  constructor(public readonly status: number) {
    super(`Request failed (${status})`);
  }
}

export function projectsQueryOptions(client = api) {
  return queryOptions({
    queryKey: ["projects", "account-list"],
    refetchOnMount: false,
    retryOnMount: false,
    queryFn: async ({ signal }) => {
      const projects = new Map<string, SelectableProject>();
      const visitedCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const response = await client.projects.$get(
          { query: cursor === null ? {} : { cursor } },
          { init: { signal } },
        );
        if (!response.ok) throw new ProjectRequestError(response.status);
        const page = await response.json();
        for (const project of page.items) projects.set(project.id, project);
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (visitedCursors.has(cursor))
            throw new Error("Invalid projects pagination");
          visitedCursors.add(cursor);
        }
      } while (cursor !== null);
      return Array.from(projects.values());
    },
  });
}

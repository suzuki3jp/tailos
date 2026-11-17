import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/shared/api";

export const projectsKey = ["projects"];
export const projectHistoryKey = ["project-history"];
export type ProjectItem = InferResponseType<
  typeof api.projects.settings.$get,
  200
>["projects"][number];
export type ProjectSettings = Omit<ProjectItem["project"], "id">;
export type RepositoryChoice = InferResponseType<
  typeof api.projects.repositories.$get,
  200
>["repositories"][number];
export type ProjectChange = InferResponseType<
  typeof api.projects.history.$get,
  200
>["changes"][number];
export function projectsQueryOptions() {
  return queryOptions({
    queryKey: projectsKey,
    queryFn: async ({ signal }) => {
      const response = await api.projects.settings.$get(undefined, {
        init: { signal },
      });
      return response.ok ? response.json() : { error: response.status };
    },
  });
}
export function repositoriesQueryOptions() {
  return queryOptions({
    queryKey: ["project-repositories"],
    queryFn: async ({ signal }) => {
      const response = await api.projects.repositories.$get(undefined, {
        init: { signal },
      });
      return response.ok ? response.json() : { error: response.status };
    },
  });
}
export function projectHistoryQueryOptions(before?: number) {
  return queryOptions({
    queryKey: [...projectHistoryKey, before],
    queryFn: async ({ signal }) => {
      const query = before === undefined ? {} : { before: String(before) };
      const response = await api.projects.history.$get(
        { query },
        { init: { signal } },
      );
      return response.ok ? response.json() : { error: response.status };
    },
  });
}

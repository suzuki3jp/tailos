import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/shared/api";

type RoutineRoutes = (typeof api.projects)[":projectId"]["routines"];

export type Routine = InferResponseType<
  RoutineRoutes["$get"],
  200
>["routines"][number];

export const routinesKey = (projectId: string) => [
  "project-routines",
  projectId,
];

export class RoutineRequestError extends Error {
  constructor(readonly status: number) {
    super("Routine を取得できませんでした。");
  }
}

/** The Project's Routines, oldest first. */
export function routinesQueryOptions(projectId: string, client = api) {
  return queryOptions({
    queryKey: routinesKey(projectId),
    queryFn: async ({ signal }) => {
      const response = await client.projects[":projectId"].routines.$get(
        { param: { projectId } },
        { init: { signal } },
      );
      if (!response.ok) throw new RoutineRequestError(response.status);
      return response.json();
    },
  });
}

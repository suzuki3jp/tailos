import { queryOptions } from "@tanstack/react-query";
import { api } from "@/shared/api";

/** How many of a Routine's latest Sessions its page shows. */
export const ROUTINE_SESSION_LIMIT = 10;

export class RoutineSessionsError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status})`);
  }
}

/** The Sessions the Routine keeps for its issues, most recently updated first. */
export function routineSessionsQueryOptions(
  projectId: string,
  routineId: string,
  client = api,
) {
  return queryOptions({
    queryKey: ["routine-sessions", projectId, routineId],
    queryFn: async ({ signal }) => {
      const response = await client.projects[":projectId"].sessions.$get(
        {
          param: { projectId },
          query: { limit: String(ROUTINE_SESSION_LIMIT), routineId },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new RoutineSessionsError(response.status);
      return response.json();
    },
  });
}

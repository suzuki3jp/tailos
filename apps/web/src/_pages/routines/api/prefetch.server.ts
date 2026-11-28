import { QueryClient, dehydrate } from "@tanstack/react-query";
import { createServerApi } from "@/shared/api/index.server";
import { accountProfileQueryOptions } from "@/entities/account";
import { accountSessionsQueryOptions } from "@/entities/session";
import { routinesQueryOptions } from "@/entities/routine";
import { projectsQueryOptions } from "@/features/select-project";
import { routineSessionsQueryOptions } from "./routine-sessions";
import { requestStatus } from "./request-status";

/**
 * Reads what a Routines page shows, in parallel: the sidebar's account and
 * Recent Sessions, the Project, its Routines and, for one Routine, its
 * Sessions. Each call belongs to one request.
 */
export async function prefetchRoutines(
  cookie: string,
  projectId: string,
  routineId?: string,
) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    const api = createServerApi(cookie);
    await Promise.all([
      cache.prefetchQuery(accountProfileQueryOptions(api)),
      cache.prefetchInfiniteQuery(accountSessionsQueryOptions(api)),
      cache.prefetchQuery(projectsQueryOptions(api)),
      cache.prefetchQuery(routinesQueryOptions(projectId, api)),
      routineId &&
        cache.prefetchQuery(
          routineSessionsQueryOptions(projectId, routineId, api),
        ),
    ]);
    const state = dehydrate(cache, {
      shouldDehydrateQuery: (query) => query.state.status !== "pending",
    });
    // RSC requires plain objects: keep the status, never error details.
    for (const query of state.queries) {
      if (query.state.status === "error") {
        const status = requestStatus(query.state.error);
        const error = {
          name: "RoutineRequestError",
          message: "Routine data could not be loaded.",
          ...(status === undefined ? {} : { status }),
        };
        query.state = { ...query.state, error, fetchFailureReason: error };
      }
    }
    return state;
  } finally {
    cache.clear();
  }
}

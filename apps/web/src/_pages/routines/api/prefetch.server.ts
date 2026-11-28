import { QueryClient } from "@tanstack/react-query";
import {
  createServerApi,
  dehydrateApiQueries,
} from "@/shared/api/index.server";
import { accountProfileQueryOptions } from "@/entities/account";
import { accountSessionsQueryOptions } from "@/entities/session";
import { routinesQueryOptions } from "@/entities/routine";
import { projectsQueryOptions } from "@/features/select-project";
import { routineSessionsQueryOptions } from "./routine-sessions";

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
    return dehydrateApiQueries(cache, {
      name: "RoutineRequestError",
      message: "Routine data could not be loaded.",
    });
  } finally {
    cache.clear();
  }
}

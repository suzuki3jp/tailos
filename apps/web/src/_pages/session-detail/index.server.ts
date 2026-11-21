import { QueryClient, dehydrate } from "@tanstack/react-query";
import { createServerApi } from "@/shared/api/index.server";
import {
  projectSessionQueryOptions,
  projectSessionsQueryOptions,
  sessionErrorStatus,
} from "./api/queries";

export async function prefetchProjectSession(
  cookie: string,
  projectId: string,
  sessionId: string,
) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    const api = createServerApi(cookie);
    await Promise.all([
      cache.prefetchQuery(
        projectSessionQueryOptions(projectId, sessionId, api),
      ),
      cache.prefetchInfiniteQuery(projectSessionsQueryOptions(projectId, api)),
    ]);
    const state = dehydrate(cache, {
      shouldDehydrateQuery: (query) => query.state.status !== "pending",
    });
    for (const query of state.queries) {
      if (query.state.status === "error") {
        const error = {
          name: "SessionRequestError",
          message: "Session data could not be loaded.",
          status: sessionErrorStatus(query.state.error) ?? null,
        };
        query.state = { ...query.state, error, fetchFailureReason: error };
      }
    }
    return state;
  } finally {
    cache.clear();
  }
}

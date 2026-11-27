import { QueryClient, dehydrate } from "@tanstack/react-query";
import { createServerApi } from "@/shared/api/index.server";
import { accountProfileQueryOptions } from "@/entities/account";
import { accountSessionsQueryOptions } from "@/entities/session";
import { projectSessionQueryOptions, sessionErrorStatus } from "./api/queries";

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
      cache.prefetchQuery(accountProfileQueryOptions(api)),
      cache.prefetchQuery(
        projectSessionQueryOptions(projectId, sessionId, api),
      ),
      // The sidebar's Recent Sessions.
      cache.prefetchInfiniteQuery(accountSessionsQueryOptions(api)),
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

import { QueryClient } from "@tanstack/react-query";
import {
  createServerApi,
  dehydrateApiQueries,
} from "@/shared/api/index.server";
import { accountProfileQueryOptions } from "@/entities/account";
import { accountSessionsQueryOptions } from "@/entities/session";
import { projectSessionQueryOptions } from "./api/queries";

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
    return dehydrateApiQueries(cache, {
      name: "SessionRequestError",
      message: "Session data could not be loaded.",
      missingStatus: null,
    });
  } finally {
    cache.clear();
  }
}

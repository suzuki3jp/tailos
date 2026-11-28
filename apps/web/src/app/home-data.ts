import { projectsQueryOptions } from "@/features/select-project";
import { QueryClient } from "@tanstack/react-query";
import { accountSessionsQueryOptions } from "@/entities/session";
import {
  createServerApi,
  dehydrateApiQueries,
} from "@/shared/api/index.server";
import { accountProfileQueryOptions } from "@/entities/account";

// Each invocation belongs to one request; neither cookies nor cache are shared.
// Every sidebar shows Recent Sessions, so pages read the same three queries.
export async function prefetchNavigation(cookieHeader: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException("Home prefetch timed out", "TimeoutError"),
      ),
    10_000,
  );
  try {
    const api = createServerApi(cookieHeader, deadline.signal);
    await Promise.all([
      client.prefetchQuery(accountProfileQueryOptions(api)),
      client.prefetchQuery(projectsQueryOptions(api)),
      client.prefetchInfiniteQuery(accountSessionsQueryOptions(api)),
    ]);
    return dehydrateApiQueries(client, {
      name: "HomeRequestError",
      message: "Data could not be loaded.",
    });
  } finally {
    clearTimeout(timer);
    client.clear();
  }
}

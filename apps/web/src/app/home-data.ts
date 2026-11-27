import { projectsQueryOptions } from "@/features/select-project";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import { accountSessionsQueryOptions } from "@/entities/session";
import { createServerApi } from "@/shared/api/index.server";
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
    const state = dehydrate(client, {
      shouldDehydrateQuery: (query) => query.state.status !== "pending",
    });
    // RSC requires plain objects. Keep HTTP status, but never ship error details,
    // stacks, headers, or a request-scoped query function to the browser.
    for (const query of state.queries) {
      if (query.state.status === "error") {
        const error: unknown = query.state.error;
        const status =
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : undefined;
        const safeError = {
          name: "HomeRequestError",
          message: "Data could not be loaded.",
          ...(status === undefined ? {} : { status }),
        };
        query.state = {
          ...query.state,
          error: safeError,
          fetchFailureReason: safeError,
        };
      }
    }
    return state;
  } finally {
    clearTimeout(timer);
    client.clear();
  }
}

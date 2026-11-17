import { QueryClient, dehydrate } from "@tanstack/react-query";
import {
  homeProjectsQueryOptions,
  homeSessionsQueryOptions,
} from "@/_pages/home/index.server";
import { createServerApi } from "@/shared/api/index.server";

// Each invocation belongs to one request; neither cookies nor cache are shared.
export async function prefetchHome(cookieHeader: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const api = createServerApi(cookieHeader);
  await Promise.all([
    client.prefetchQuery(homeProjectsQueryOptions(api)),
    client.prefetchInfiniteQuery(homeSessionsQueryOptions(api)),
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
  client.clear();
  return state;
}

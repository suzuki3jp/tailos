import { queryOptions } from "@tanstack/react-query";
import { api } from "@/shared/api";

export function sessionQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["sessions", id],
    queryFn: async ({ signal }) => {
      const response = await api.sessions[":id"].$get(
        { param: { id } },
        { init: { signal } },
      );
      return response.ok ? await response.json() : { error: response.status };
    },
    refetchInterval: (query) => {
      const detail = query.state.data;
      return detail &&
        "runs" in detail &&
        detail.runs.some(
          (run) => run.status === "queued" || run.status === "running",
        )
        ? 5000
        : false;
    },
  });
}

import { queryOptions } from "@tanstack/react-query";
import { api } from "@/shared/api";

export const connectionKey = ["connection"];

export function connectionQueryOptions() {
  return queryOptions({
    queryKey: connectionKey,
    queryFn: async ({ signal }) => {
      const response = await api.connect.$get(undefined, {
        init: { signal },
      });
      return response.ok ? await response.json() : { error: response.status };
    },
    refetchInterval: (query) => {
      const status = query.state.data;
      return status && "state" in status && status.state === "pending"
        ? 5000
        : false;
    },
  });
}

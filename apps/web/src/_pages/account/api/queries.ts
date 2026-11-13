import { queryOptions } from "@tanstack/react-query";
import { api } from "@/shared/api";

export function accountQueryOptions() {
  return queryOptions({
    queryKey: ["account"],
    queryFn: async ({ signal }) => {
      const response = await api.account.$get(undefined, {
        init: { signal },
      });
      if (response.status === 401) return null;
      return response.ok ? await response.json() : { error: response.status };
    },
  });
}

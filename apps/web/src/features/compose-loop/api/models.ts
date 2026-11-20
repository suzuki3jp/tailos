import { queryOptions } from "@tanstack/react-query";
import { api } from "@/shared/api";

export function codexModelsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: ["codex", "models"],
    enabled,
    queryFn: async ({ signal }) => {
      const response = await api.connect.codex.models.$get(undefined, {
        init: { signal },
      });
      if (!response.ok) throw new Error("Model catalog unavailable");
      return (await response.json()).models;
    },
  });
}

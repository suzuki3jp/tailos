import { queryOptions } from "@tanstack/react-query";
import { api } from "@/shared/api";

export const mcpKeysKey = ["mcp-keys"];

export function mcpKeysQueryOptions() {
  return queryOptions({
    queryKey: mcpKeysKey,
    queryFn: async ({ signal }) => {
      const response = await api["mcp-keys"].$get(undefined, {
        init: { signal },
      });
      return response.ok ? response.json() : { error: response.status };
    },
  });
}

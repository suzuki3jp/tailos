import { queryOptions } from "@tanstack/react-query";
import { api } from "@/shared/api";

class AccountProfileError extends Error {
  constructor(public readonly status: number) {
    super("Account profile could not be loaded.");
  }
}

export function accountProfileQueryOptions(client = api) {
  return queryOptions({
    queryKey: ["account", "profile"],
    refetchOnMount: false,
    retryOnMount: false,
    queryFn: async ({ signal }) => {
      const response = await client.account.profile.$get(undefined, {
        init: { signal },
      });
      if (!response.ok) throw new AccountProfileError(response.status);
      return response.json();
    },
  });
}

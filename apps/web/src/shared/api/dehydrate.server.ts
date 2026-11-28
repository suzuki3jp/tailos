import { dehydrate, type QueryClient } from "@tanstack/react-query";
import { requestErrorStatus } from "./request-error";

type ErrorDescription = {
  name: string;
  message: string;
  missingStatus?: null;
};

/** Only a plain error description and HTTP status may cross the RSC boundary. */
export function dehydrateApiQueries(
  cache: QueryClient,
  { name, message, missingStatus }: ErrorDescription,
) {
  const state = dehydrate(cache, {
    shouldDehydrateQuery: (query) => query.state.status !== "pending",
  });
  for (const query of state.queries) {
    if (query.state.status !== "error") continue;
    const status = requestErrorStatus(query.state.error) ?? missingStatus;
    const error = {
      name,
      message,
      ...(status === undefined ? {} : { status }),
    };
    query.state = { ...query.state, error, fetchFailureReason: error };
  }
  return state;
}

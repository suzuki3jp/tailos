import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/shared/api";

class SessionRequestError extends Error {
  constructor(public readonly status: number) {
    super("Session request failed");
  }
}

export function sessionErrorStatus(error: unknown) {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

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
      return detail && "runs" in detail && detail.runs.some(isActiveRun)
        ? 5000
        : false;
    },
  });
}

export function projectSessionQueryOptions(
  projectId: string,
  id: string,
  client = api,
) {
  return queryOptions({
    queryKey: ["projects", projectId, "sessions", id],
    refetchOnMount: false,
    retryOnMount: false,
    queryFn: async ({ signal }) => {
      const response = await client.projects[":projectId"].sessions[":id"].$get(
        {
          param: {
            projectId: encodeURIComponent(projectId),
            id: encodeURIComponent(id),
          },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new SessionRequestError(response.status);
      return response.json();
    },
    // Business-state transitions arrive through the Session stream. Reconnect
    // and focus still reconcile via the HTTP snapshot.
    refetchInterval: false,
  });
}

type ProjectSessionResponse = InferResponseType<
  (typeof api.projects)[":projectId"]["sessions"][":id"]["$get"],
  200
>;
export type ProjectSession = ProjectSessionResponse["detail"];
export type SessionRun = ProjectSession["runs"][number];

export function isActiveRun(run: { status: string }) {
  return run.status === "queued" || run.status === "running";
}

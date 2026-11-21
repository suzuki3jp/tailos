import { queryOptions } from "@tanstack/react-query";
import { parseTimelineSnapshot } from "@tailos/core/timeline";
import { api } from "@/shared/api";
import { apiOrigin } from "@/shared/config";

export class TimelineRequestError extends Error {
  constructor(public readonly status: number) {
    super("Execution history could not be loaded");
  }
}

export function timelinePath(projectId: string | undefined, id: string) {
  return projectId
    ? `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(id)}`
    : `/sessions/${encodeURIComponent(id)}`;
}

export function timelineStreamUrl(projectId: string | undefined, id: string) {
  const url = new URL(`/v1${timelinePath(projectId, id)}/stream`, apiOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export async function loadTimeline(
  projectId: string | undefined,
  id: string,
  client = api,
  before?: number,
  signal?: AbortSignal,
) {
  const query = before === undefined ? {} : { before: String(before) };
  const response = projectId
    ? await client.projects[":projectId"].sessions[":id"].timeline.$get(
        {
          param: {
            projectId: encodeURIComponent(projectId),
            id: encodeURIComponent(id),
          },
          query,
        },
        { init: { signal } },
      )
    : await client.sessions[":id"].timeline.$get(
        { param: { id: encodeURIComponent(id) }, query },
        { init: { signal } },
      );
  if (!response.ok) throw new TimelineRequestError(response.status);
  return parseTimelineSnapshot(await response.json());
}

export function timelineQueryOptions(
  projectId: string | undefined,
  id: string,
  client = api,
) {
  return queryOptions({
    queryKey: ["session-timeline", projectId ?? null, id],
    queryFn: ({ signal }) =>
      loadTimeline(projectId, id, client, undefined, signal),
    refetchOnMount: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });
}

export function timelineOutputOptions(
  projectId: string | undefined,
  id: string,
  itemId: string,
  revision: number,
) {
  return queryOptions({
    queryKey: [
      "session-timeline-output",
      projectId ?? null,
      id,
      itemId,
      revision,
    ],
    queryFn: async ({ signal }) => {
      const response = projectId
        ? await api.projects[":projectId"].sessions[":id"].items[
            ":itemId"
          ].output.$get(
            {
              param: {
                projectId: encodeURIComponent(projectId),
                id: encodeURIComponent(id),
                itemId: encodeURIComponent(itemId),
              },
            },
            { init: { signal } },
          )
        : await api.sessions[":id"].items[":itemId"].output.$get(
            {
              param: {
                id: encodeURIComponent(id),
                itemId: encodeURIComponent(itemId),
              },
            },
            { init: { signal } },
          );
      if (!response.ok) throw new TimelineRequestError(response.status);
      return response.json();
    },
    retry: false,
  });
}

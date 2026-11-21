"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TimelineSnapshot } from "@tailos/core/timeline";
import { openSessionTimeline } from "./timeline-stream";
import { mergeTimeline } from "../model/timeline";
import { projectSessionQueryOptions, sessionQueryOptions } from "./queries";
import { loadTimeline, timelineQueryOptions } from "./timeline";

export function useSessionTimeline(projectId: string | undefined, id: string) {
  const cache = useQueryClient();
  const options = timelineQueryOptions(projectId, id);
  const query = useQuery({
    ...options,
    initialData: () => {
      if (projectId)
        return cache.getQueryData(
          projectSessionQueryOptions(projectId, id).queryKey,
        )?.detail.timeline;
      const session = cache.getQueryData(sessionQueryOptions(id).queryKey);
      return session && "timeline" in session ? session.timeline : undefined;
    },
  });
  const [connection, setConnection] = useState<
    "connecting" | "live" | "reconnecting" | "unauthorized"
  >("connecting");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);

  useEffect(() => {
    if (query.isSuccess)
      return openSessionTimeline(cache, projectId, id, setConnection);
  }, [projectId, id, query.isSuccess, cache]);

  async function loadOlder() {
    if (loadingOlder || query.data?.before == null) return;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await loadTimeline(
        projectId,
        id,
        undefined,
        query.data.before,
      );
      cache.setQueryData<TimelineSnapshot>(options.queryKey, (old) =>
        old
          ? {
              ...old,
              items: mergeTimeline(old.items, page.items),
              before: page.before,
            }
          : old,
      );
    } catch {
      setOlderError(true);
    } finally {
      setLoadingOlder(false);
    }
  }
  async function refetch() {
    const result = await query.refetch();
    await cache.invalidateQueries({
      queryKey: projectId
        ? ["projects", projectId, "sessions", id]
        : ["sessions", id],
      exact: true,
    });
    return result;
  }
  return { ...query, refetch, connection, loadOlder, loadingOlder, olderError };
}

"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseTimelineMessage,
  type TimelineSnapshot,
} from "@tailos/core/timeline";
import { mergeTimeline } from "../model/timeline";
import { projectSessionQueryOptions, sessionQueryOptions } from "./queries";
import {
  loadTimeline,
  timelineQueryOptions,
  timelineStreamUrl,
  TimelineRequestError,
} from "./timeline";

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
    if (!query.isSuccess) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let failures = 0;
    // Frames are processed in order even when a reset needs an HTTP request.
    let work = Promise.resolve();
    const key = timelineQueryOptions(projectId, id).queryKey;
    const current = () => cache.getQueryData<TimelineSnapshot>(key);
    async function refresh(reset = false) {
      const snapshot = await loadTimeline(projectId, id);
      if (disposed) return;
      cache.setQueryData<TimelineSnapshot>(key, (old) =>
        reset || !old
          ? snapshot
          : {
              ...snapshot,
              items: mergeTimeline(old.items, snapshot.items),
              before: old.before,
              cursor: old.cursor,
            },
      );
    }
    function connect() {
      if (disposed) return;
      socket = new WebSocket(timelineStreamUrl(projectId, id));
      const active = socket;
      active.onopen = () => {
        failures = 0;
        setConnection("live");
        active.send(
          JSON.stringify({ type: "resume", after: current()?.cursor ?? 0 }),
        );
        heartbeat = setInterval(() => {
          if (active.readyState === WebSocket.OPEN)
            active.send(JSON.stringify({ type: "ping" }));
        }, 30_000);
      };
      active.onmessage = (event) => {
        work = work
          .then(async () => {
            if (disposed) return;
            const message = parseTimelineMessage(
              JSON.parse(String(event.data)),
            );
            if (message.type === "pong") return;
            if (message.type === "reset_required") {
              await refresh(true);
              await cache.invalidateQueries({
                queryKey: projectId
                  ? ["projects", projectId, "sessions", id]
                  : ["sessions", id],
                exact: true,
              });
              if (!disposed && active.readyState === WebSocket.OPEN)
                active.send(
                  JSON.stringify({
                    type: "resume",
                    after: current()?.cursor ?? 0,
                  }),
                );
              return;
            }
            cache.setQueryData<TimelineSnapshot>(key, (old) =>
              old
                ? {
                    ...old,
                    items: mergeTimeline(old.items, message.items),
                    cursor: Math.max(old.cursor, message.cursor),
                  }
                : old,
            );
            if (!disposed && active.readyState === WebSocket.OPEN)
              active.send(
                JSON.stringify({ type: "ack", cursor: message.cursor }),
              );
            if (message.captureChanged) await refresh();
            if (message.sessionChanged || message.captureChanged) {
              await cache.invalidateQueries({
                queryKey: projectId
                  ? ["projects", projectId, "sessions", id]
                  : ["sessions", id],
                exact: true,
              });
              if (projectId)
                void cache.invalidateQueries({
                  queryKey: ["projects", projectId, "sessions"],
                  exact: true,
                });
            }
          })
          .catch(() => active.close());
      };
      active.onclose = (event) => {
        if (heartbeat) clearInterval(heartbeat);
        if (disposed) return;
        if (event.code === 1008) {
          setConnection("unauthorized");
          return;
        }
        setConnection("reconnecting");
        retry = setTimeout(
          () => {
            void loadTimeline(projectId, id)
              .then(connect)
              .catch((error: unknown) => {
                if (disposed) return;
                if (
                  error instanceof TimelineRequestError &&
                  (error.status === 401 || error.status === 404)
                )
                  setConnection("unauthorized");
                else connect();
              });
          },
          Math.min(10_000, 1000 * 2 ** Math.min(failures++, 4)),
        );
      };
      active.onerror = () => active.close();
    }
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (heartbeat) clearInterval(heartbeat);
      socket?.close();
    };
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

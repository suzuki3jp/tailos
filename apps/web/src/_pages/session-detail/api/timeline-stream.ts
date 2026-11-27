import type { QueryClient } from "@tanstack/react-query";
import { accountSessionsQueryOptions } from "@/entities/session";
import {
  parseTimelineMessage,
  type TimelineSnapshot,
} from "@tailos/core/timeline";
import { mergeTimeline } from "../model/timeline";
import {
  loadTimeline,
  timelineQueryOptions,
  timelineStreamUrl,
  TimelineRequestError,
} from "./timeline";

export type TimelineConnection =
  | "connecting"
  | "live"
  | "reconnecting"
  | "unauthorized";

export function openSessionTimeline(
  cache: QueryClient,
  projectId: string | undefined,
  id: string,
  setConnection: (state: TimelineConnection) => void,
) {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let failures = 0;
  // Frames are processed in order even when a reset needs an HTTP request.
  const key = timelineQueryOptions(projectId, id).queryKey;
  const current = () => cache.getQueryData<TimelineSnapshot>(key);
  async function refresh(active: WebSocket, reset = false) {
    const snapshot = await loadTimeline(projectId, id);
    if (disposed || socket !== active || active.readyState !== WebSocket.OPEN)
      return false;
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
    return true;
  }
  function connect() {
    if (disposed) return;
    socket = new WebSocket(timelineStreamUrl(projectId, id));
    const active = socket;
    let work = Promise.resolve();
    active.onopen = () => {
      if (disposed || socket !== active) return;
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
          if (
            disposed ||
            socket !== active ||
            active.readyState !== WebSocket.OPEN
          )
            return;
          const message = parseTimelineMessage(JSON.parse(String(event.data)));
          if (message.type === "pong") return;
          if (message.type === "reset_required") {
            if (!(await refresh(active, true))) return;
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
          if (message.captureChanged && !(await refresh(active))) return;
          if (message.sessionChanged || message.captureChanged) {
            await cache.invalidateQueries({
              queryKey: projectId
                ? ["projects", projectId, "sessions", id]
                : ["sessions", id],
              exact: true,
            });
            // Titles and order in the sidebar's Recent Sessions.
            void cache.invalidateQueries({
              queryKey: accountSessionsQueryOptions().queryKey,
              exact: true,
            });
          }
        })
        .catch(() => active.close());
    };
    active.onclose = (event) => {
      if (disposed || socket !== active) return;
      if (heartbeat) clearInterval(heartbeat);
      if (event.code === 1008) {
        setConnection("unauthorized");
        return;
      }
      setConnection("reconnecting");
      retry = setTimeout(
        () => {
          void loadTimeline(projectId, id)
            .then(async () => {
              if (disposed || socket !== active) return;
              // HTTP can remain available when a proxy or service blocks WS.
              // Reconcile business state on each bounded reconnect attempt.
              await cache.invalidateQueries({
                queryKey: projectId
                  ? ["projects", projectId, "sessions", id]
                  : ["sessions", id],
                exact: true,
              });
              if (!disposed && socket === active) connect();
            })
            .catch((error: unknown) => {
              if (disposed || socket !== active) return;
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
}

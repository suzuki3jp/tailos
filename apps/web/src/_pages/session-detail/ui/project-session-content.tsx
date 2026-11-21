"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/shared/ui/button";
import { LoopComposer } from "@/features/compose-loop";
import { RequestState } from "@/widgets/request-state";
import { projectSessionQueryOptions, sessionErrorStatus } from "../api/queries";
import { SessionConversation } from "./session-conversation";
import { useSessionTimeline } from "../api/use-session-timeline";

type Props = { projectId: string; sessionId: string };
const connectionLabels = {
  live: "Live",
  unauthorized: "Sign in again to receive live updates.",
  reconnecting: "Reconnecting… Saved history remains available.",
  connecting: "Connecting…",
};
function olderLabel(loading: boolean, failed: boolean) {
  if (loading) return "Loading…";
  if (failed) return "Retry earlier activity";
  return "Load earlier activity";
}

export function SessionProjectName({ projectId, sessionId }: Props) {
  const { data } = useQuery({
    ...projectSessionQueryOptions(projectId, sessionId),
    refetchInterval: false,
  });
  const name = data?.projectName ?? projectId;
  return (
    <span
      title={name}
      className="min-w-0 flex-1 truncate rounded-lg border px-2.5 py-1.5 text-control"
    >
      {name}
    </span>
  );
}

export function ProjectSessionContent({ projectId, sessionId }: Props) {
  const session = useQuery(projectSessionQueryOptions(projectId, sessionId));
  const timeline = useSessionTimeline(projectId, sessionId);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [newActivity, setNewActivity] = useState(false);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (pinned.current) element.scrollTop = element.scrollHeight;
    else setNewActivity(true);
  }, [timeline.data?.items, session.data?.detail.messages]);
  const result = session.data;
  if (session.isPending)
    return (
      <p role="status" className="p-6 text-muted-foreground">
        Loading session…
      </p>
    );
  const status = sessionErrorStatus(session.error);
  if (!result || status === 401 || status === 404)
    return (
      <div className="mx-auto w-full max-w-172 p-6">
        <RequestState
          status={status}
          missing="Session が見つかりません。"
          retry={() => void session.refetch()}
        />
      </div>
    );
  return (
    <>
      <div
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            48;
          if (pinned.current) setNewActivity(false);
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-172 px-7.5 pt-4 text-control-xs text-muted-foreground">
          <p role="status">{connectionLabels[timeline.connection]}</p>
          {timeline.isError && (
            <div>
              <p>Execution history could not be loaded.</p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void timeline.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {timeline.data?.before !== null &&
            timeline.data?.before !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                disabled={timeline.loadingOlder}
                onClick={() => void timeline.loadOlder()}
              >
                {olderLabel(timeline.loadingOlder, timeline.olderError)}
              </Button>
            )}
        </div>
        <SessionConversation
          detail={result.detail}
          timeline={timeline.data}
          projectId={projectId}
        />
      </div>
      {newActivity && (
        <div className="flex justify-center py-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              pinned.current = true;
              setNewActivity(false);
              if (scroll.current)
                scroll.current.scrollTop = scroll.current.scrollHeight;
            }}
          >
            New activity ↓
          </Button>
        </div>
      )}
      <div className="mx-auto w-full max-w-166 shrink-0 px-3 pb-3">
        <LoopComposer mode="session" />
      </div>
    </>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/shared/ui/button";
import { LoopComposer, type LoopMessage } from "@/features/compose-loop";
import { RequestState } from "@/widgets/request-state";
import {
  isActiveRun,
  projectSessionQueryOptions,
  sessionErrorStatus,
} from "../api/queries";
import { sendMessage, SendMessageError } from "../api/send-message";
import { SessionConversation } from "./session-conversation";
import { useSessionTimeline } from "../api/use-session-timeline";

type Props = { projectId: string; sessionId: string };
const connectionLabels = {
  unauthorized: "Sign in again to receive live updates.",
  reconnecting: "Reconnecting… Saved history remains available.",
  connecting: "Connecting…",
};
function olderLabel(loading: boolean, failed: boolean) {
  if (loading) return "Loading…";
  if (failed) return "Retry earlier activity";
  return "Load earlier activity";
}

function sendFailure(error: unknown) {
  const status = error instanceof SendMessageError ? error.status : undefined;
  const code = error instanceof SendMessageError ? error.code : undefined;
  if (code === "codex_not_connected")
    return (
      <>
        Connect Codex to continue.{" "}
        <Link href="/connect" className="underline">
          Connect
        </Link>
      </>
    );
  if (code === "session_busy")
    return "The loop is still working. Send once it finishes.";
  if (status === 401)
    return (
      <>
        Your sign-in has expired.{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </>
    );
  if (status === 404) return "This session can no longer take messages.";
  if (status === 400) return "Check the message and model, then try again.";
  return "Try again.";
}

function composerStatus(error: unknown, working: boolean) {
  if (error) return <>Your message wasn’t sent. {sendFailure(error)}</>;
  if (working) return "The loop is working. You can send once it finishes.";
  return undefined;
}

/**
 * Sends the next message of the Session, which continues with the settings
 * of its latest Turn. A working Session takes none.
 */
function SessionComposer({
  projectId,
  sessionId,
  working,
}: Props & { working: boolean }) {
  const queryClient = useQueryClient();
  // One ID per draft, so resending the same message starts one Turn.
  const draft = useRef<{ key: string; requestId: string } | null>(null);
  const [message, setMessage] = useState("");
  const send = useMutation({
    mutationFn: (input: Parameters<typeof sendMessage>[0]) =>
      sendMessage(input),
    onSuccess: async () => {
      draft.current = null;
      setMessage("");
      await queryClient.invalidateQueries({
        queryKey: projectSessionQueryOptions(projectId, sessionId).queryKey,
      });
    },
  });
  const submit = (input: LoopMessage) => {
    const key = JSON.stringify(input);
    if (draft.current?.key !== key)
      draft.current = { key, requestId: crypto.randomUUID() };
    send.mutate({
      ...input,
      projectId,
      sessionId,
      requestId: draft.current.requestId,
    });
  };
  return (
    <LoopComposer
      mode="session"
      message={message}
      onMessageChange={setMessage}
      onSubmit={submit}
      pending={send.isPending}
      disabled={working}
      status={composerStatus(send.isError ? send.error : undefined, working)}
    />
  );
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
      className="flex h-8 min-w-0 flex-1 items-center truncate rounded-lg border px-2.5 text-control"
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
          <p role="status">
            {timeline.connection === "live"
              ? null
              : connectionLabels[timeline.connection]}
          </p>
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
        <SessionComposer
          projectId={projectId}
          sessionId={sessionId}
          working={result.detail.runs.some(isActiveRun)}
        />
      </div>
    </>
  );
}

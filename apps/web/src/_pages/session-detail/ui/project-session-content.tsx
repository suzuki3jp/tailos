"use client";

import { useQuery } from "@tanstack/react-query";
import { LoopComposer } from "@/features/compose-loop";
import { RequestState } from "@/widgets/request-state";
import { projectSessionQueryOptions, sessionErrorStatus } from "../api/queries";
import { SessionConversation } from "./session-conversation";

type Props = { projectId: string; sessionId: string };

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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SessionConversation detail={result.detail} />
      </div>
      <div className="mx-auto w-full max-w-166 shrink-0 px-3 pb-3">
        <LoopComposer mode="session" />
      </div>
    </>
  );
}

"use client";

import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  IconMessage,
  IconMessageDots,
  IconMessageReport,
} from "@tabler/icons-react";
import { sessionPath } from "@/shared/lib/session-path";
import { Button } from "@/shared/ui/button";
import { RequestState } from "@/widgets/request-state";
import {
  projectSessionsQueryOptions,
  sessionErrorStatus,
} from "../api/queries";

const statusIcons = {
  failed: IconMessageReport,
  queued: IconMessageDots,
  running: IconMessageDots,
  succeeded: IconMessage,
};

export function ProjectSessionsPanel({
  projectId,
  sessionId,
  compact = false,
}: {
  projectId: string;
  sessionId: string;
  compact?: boolean;
}) {
  const sessions = useInfiniteQuery(projectSessionsQueryOptions(projectId));
  const pages = sessions.data?.pages ?? [];
  const items = new Map(
    pages.flatMap((page) => page.items.map((item) => [item.id, item] as const)),
  );
  const error = sessionErrorStatus(sessions.error);

  if (error === 401) return null;

  return (
    <div className={compact ? "pb-2" : "space-y-3 py-6"}>
      {!compact && (
        <h2 className="px-3 text-page-title font-semibold">Sessions</h2>
      )}
      <ul className="divide-y">
        {[...items.values()].map((session) => {
          const status = session.latestRun?.status;
          const Icon = status ? statusIcons[status] : IconMessage;
          return (
            <li key={session.id}>
              <Link
                href={sessionPath(session.id, projectId)}
                aria-current={session.id === sessionId ? "page" : undefined}
                title={session.title}
                className="flex items-center gap-3 px-3 py-3 text-body hover:bg-accent aria-[current=page]:bg-accent"
              >
                <Icon aria-hidden="true" size={20} className="shrink-0" />
                <span className="truncate">{session.title}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {sessions.isPending && (
        <p className="px-3 text-sm text-muted-foreground" role="status">
          Loading sessions…
        </p>
      )}
      {items.size === 0 && sessions.isSuccess && !error && (
        <p className="px-3 text-sm text-muted-foreground">No sessions yet.</p>
      )}
      {sessions.isError && (
        <div className="px-3">
          <RequestState
            status={error}
            missing="Session が見つかりません。"
            retry={() =>
              void (sessions.isFetchNextPageError
                ? sessions.fetchNextPage()
                : sessions.refetch())
            }
          />
        </div>
      )}
      {sessions.hasNextPage && !sessions.isFetchNextPageError && (
        <div className="px-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={sessions.isFetching}
            onClick={() => void sessions.fetchNextPage()}
          >
            {sessions.isFetchingNextPage
              ? "Loading sessions…"
              : "Load more sessions"}
          </Button>
        </div>
      )}
    </div>
  );
}

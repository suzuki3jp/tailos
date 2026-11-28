"use client";

import Link from "next/link";
import { useId } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  accountSessionsQueryOptions,
  uniqueSessions,
  UnreadMark,
  type AccountSession,
} from "@/entities/session";
import { sessionPath } from "@/shared/lib/session-path";
import { Button } from "@/shared/ui/design-systems";

const SIDEBAR_SESSION_LIMIT = 10;

export function SidebarRecentSessions({
  activeSessionId,
}: {
  activeSessionId?: string;
}) {
  const headingId = useId();
  const query = useInfiniteQuery(accountSessionsQueryOptions());
  const status =
    query.error && "status" in query.error ? query.error.status : undefined;
  // The account footer already offers Sign in.
  if (status === 401 || query.isPending) return null;
  const sessions = uniqueSessions(query.data?.pages, SIDEBAR_SESSION_LIMIT);
  return (
    <section aria-labelledby={headingId} className="mt-6 flex flex-col gap-2.5">
      <h2
        id={headingId}
        className="px-6 text-body font-normal text-foreground-strong"
      >
        Recent Sessions
      </h2>
      {sessions.length > 0 && (
        <ul>
          {sessions.map((session) => (
            <SidebarSessionItem
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
            />
          ))}
        </ul>
      )}
      {query.isSuccess && sessions.length === 0 && (
        <p className="px-6 text-caption text-muted-foreground">
          No sessions yet.
        </p>
      )}
      {query.isError && (
        <div className="px-6 text-xs text-muted-foreground">
          <p role="status">Sessions could not be loaded.</p>
          <Button
            unstyled
            type="button"
            className="underline"
            isDisabled={query.isFetching}
            onPress={() => void query.refetch()}
          >
            Retry sessions
          </Button>
        </div>
      )}
    </section>
  );
}

function SidebarSessionItem({
  session,
  active,
  unread = false,
}: {
  session: AccountSession;
  active: boolean;
  /** No read state exists yet, so callers leave this unset. */
  unread?: boolean;
}) {
  return (
    <li className="px-3">
      <Link
        href={sessionPath(session.id, session.project?.id)}
        aria-current={active ? "page" : undefined}
        title={session.title}
        className="flex items-center rounded-sm py-1.5 pr-1.5 pl-3 text-body text-foreground-strong hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-selected"
      >
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {/* Reserve the mark's place so titles truncate at the same width. */}
        <span className="-my-px flex size-4.25 shrink-0 items-center justify-center">
          {unread && <UnreadMark />}
        </span>
      </Link>
    </li>
  );
}

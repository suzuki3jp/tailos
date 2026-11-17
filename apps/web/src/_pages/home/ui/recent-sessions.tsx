"use client";

import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { IconMessage, IconMessageDots } from "@tabler/icons-react";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import {
  HomeRequestError,
  homeSessionsQueryOptions,
  type HomeSession,
} from "../api/queries";
import { updatedLabel } from "../model/session-presentation";
import { DataRequestState } from "./data-request-state";

function SessionRow({ session }: { session: HomeSession }) {
  const active =
    session.latestRun?.status === "running" ||
    session.latestRun?.status === "queued";
  const Icon = active ? IconMessageDots : IconMessage;
  return (
    <div className="space-y-1.5 p-3">
      <Link
        href={`/sessions/${encodeURIComponent(session.id)}`}
        className="flex items-start gap-3 rounded-sm text-foreground-strong hover:underline"
      >
        <Icon aria-hidden="true" size={20} className="shrink-0" />
        <span className="min-w-0 text-body wrap-anywhere">{session.title}</span>
      </Link>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 pl-8 text-caption text-muted-foreground">
        {session.trigger && (
          <a
            href={session.trigger.url}
            className="rounded-sm hover:underline"
            title={session.trigger.repository}
          >
            Triggered by Issue #{session.trigger.number} ·{" "}
            {session.trigger.repository}
          </a>
        )}
        <time
          dateTime={new Date(session.updatedAt).toISOString()}
          title={new Date(session.updatedAt).toISOString()}
        >
          {updatedLabel(session.updatedAt)}
        </time>
        {session.latestRun && (
          <span
            className={
              session.latestRun.status === "failed"
                ? "text-destructive"
                : undefined
            }
          >
            {session.latestRun.status}
            {session.latestRun.status === "failed" &&
            session.latestRun.errorCode
              ? ` · ${session.latestRun.errorCode}`
              : ""}
          </span>
        )}
      </div>
    </div>
  );
}

export function RecentSessions() {
  const query = useInfiniteQuery(homeSessionsQueryOptions());
  const sessionsById = new Map<string, HomeSession>();
  for (const page of query.data?.pages ?? []) {
    for (const session of page.items) {
      if (!sessionsById.has(session.id)) sessionsById.set(session.id, session);
    }
  }
  const sessions = Array.from(sessionsById.values());
  const unauthorized =
    query.error instanceof HomeRequestError && query.error.status === 401;
  return (
    <section
      id="recent-sessions"
      aria-labelledby="recent-sessions-heading"
      className="scroll-mt-6 space-y-2.5"
    >
      <h2
        id="recent-sessions-heading"
        className="text-section-title font-semibold text-foreground-strong"
      >
        Recent Sessions
      </h2>
      {query.isPending ? (
        <div
          role="status"
          aria-label="Loading sessions"
          className="space-y-3 py-3"
        >
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : unauthorized ? (
        <DataRequestState
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : (
        <>
          {sessions.length > 0 && (
            <div className="divide-y divide-border rounded-sm">
              {sessions.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
            </div>
          )}
          {!query.isError && sessions.length === 0 && (
            <p className="py-3 text-caption text-muted-foreground">
              No sessions yet.
            </p>
          )}
          {query.isError && (
            <DataRequestState
              error={query.error}
              retry={() =>
                void (query.isFetchNextPageError
                  ? query.fetchNextPage()
                  : query.refetch())
              }
            />
          )}
          {query.hasNextPage && !query.isFetchNextPageError && (
            <Button
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more sessions"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

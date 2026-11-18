"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/shared/ui/button";
import {
  homeSessionsQueryOptions,
  requestErrorStatus,
  type HomeSession,
} from "../api/queries";
import { DataRequestState } from "./data-request-state";
import { SessionRow } from "./session-row";
import { useProjectSelection } from "./project-selection";

const RECENT_SESSION_LIMIT = 5;

export function SessionList() {
  const query = useInfiniteQuery(homeSessionsQueryOptions());
  const { error: projectError } = useProjectSelection();
  const sessionsById = new Map<string, HomeSession>();
  for (const page of query.data?.pages ?? []) {
    for (const session of page.items) {
      if (!sessionsById.has(session.id)) sessionsById.set(session.id, session);
    }
  }
  const sessions = Array.from(sessionsById.values()).slice(
    0,
    RECENT_SESSION_LIMIT,
  );
  if (requestErrorStatus(query.error) === 401) {
    if (requestErrorStatus(projectError) === 401) return null;
    return (
      <DataRequestState
        error={query.error}
        retry={() => void query.refetch()}
      />
    );
  }
  return (
    <>
      {sessions.length > 0 && (
        <div className="divide-y divide-border rounded-sm">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              now={query.dataUpdatedAt}
            />
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
      {sessions.length < RECENT_SESSION_LIMIT &&
        query.hasNextPage &&
        !query.isFetchNextPageError && (
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more sessions"}
          </Button>
        )}
    </>
  );
}

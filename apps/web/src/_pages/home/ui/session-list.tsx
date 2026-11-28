"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/shared/ui/design-systems";
import {
  accountSessionsQueryOptions,
  uniqueSessions,
} from "@/entities/session";
import { requestErrorStatus } from "../api/queries";
import { DataRequestState } from "./data-request-state";
import { SessionRow } from "./session-row";
import { useProjectSelection } from "@/features/select-project";

const RECENT_SESSION_LIMIT = 5;

export function SessionList() {
  const query = useInfiniteQuery(accountSessionsQueryOptions());
  const { error: projectError } = useProjectSelection();
  const sessions = uniqueSessions(query.data?.pages, RECENT_SESSION_LIMIT);
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
            isDisabled={query.isFetching}
            onPress={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more sessions"}
          </Button>
        )}
    </>
  );
}

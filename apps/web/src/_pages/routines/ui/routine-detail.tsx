"use client";

import { useId, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconBrandGithub } from "@tabler/icons-react";
import { routinesQueryOptions, type Routine } from "@/entities/routine";
import { SessionRow } from "@/entities/session";
import { projectsQueryOptions } from "@/features/select-project";
import { RequestState } from "@/widgets/request-state";
import { requestStatus } from "../api/request-status";
import { routineSessionsQueryOptions } from "../api/routine-sessions";
import { triggerCondition, triggerEvent } from "../model/routine-summary";

type Props = { projectId: string; routineId: string };

function Section({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2
        id={headingId}
        className="text-section-title font-semibold text-foreground"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function TriggerItem({
  trigger,
  repository,
}: {
  trigger: Routine["trigger"];
  repository?: string;
}) {
  return (
    <li className="flex flex-col px-3 py-1.5">
      <p className="flex items-center gap-3 text-body leading-4 font-medium text-foreground">
        <IconBrandGithub
          aria-hidden="true"
          size={20}
          className="shrink-0 text-foreground-strong"
        />
        {repository ? `GitHub ${repository}` : "GitHub"}
      </p>
      <p className="pl-8 text-caption text-muted-foreground">
        Issue on: {triggerEvent(trigger)}{" "}
        <code className="font-mono leading-none">
          {triggerCondition(trigger)}
        </code>
      </p>
    </li>
  );
}

function RoutineSessions({ projectId, routineId }: Props) {
  const query = useQuery(routineSessionsQueryOptions(projectId, routineId));
  if (query.isPending)
    return (
      <p role="status" className="text-caption text-muted-foreground">
        Loading sessions…
      </p>
    );
  if (query.isError)
    return (
      <RequestState
        status={requestStatus(query.error)}
        missing="Sessions are not available."
        retry={() => void query.refetch()}
      />
    );
  if (query.data.items.length === 0)
    return (
      <p className="text-caption text-muted-foreground">No sessions yet.</p>
    );
  return (
    <div className="divide-y divide-border">
      {query.data.items.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          now={query.dataUpdatedAt}
        />
      ))}
    </div>
  );
}

export function RoutineDetail({ projectId, routineId }: Props) {
  const routines = useQuery(routinesQueryOptions(projectId));
  const projects = useQuery(projectsQueryOptions());
  if (routines.isPending)
    return (
      <p role="status" className="text-caption text-muted-foreground">
        Loading routine…
      </p>
    );
  if (routines.isError)
    return (
      <RequestState
        status={requestStatus(routines.error)}
        missing="This routine is not available."
        retry={() => void routines.refetch()}
      />
    );
  const routine = routines.data.routines.find(({ id }) => id === routineId);
  if (!routine)
    return (
      <RequestState
        status={404}
        missing="This routine is not available."
        retry={() => void routines.refetch()}
      />
    );
  const repository = projects.data?.find(
    (project) => project.id === projectId,
  )?.repository;
  return (
    <div className="flex flex-col gap-12">
      <h1 className="text-page-title font-semibold break-words text-foreground">
        {routine.name}
      </h1>
      <Section title="Triggers">
        <ul className="flex w-full max-w-90 flex-col divide-y divide-border">
          <TriggerItem trigger={routine.trigger} repository={repository} />
        </ul>
      </Section>
      <Section title="Prompt">
        <p className="text-body break-words whitespace-pre-wrap text-muted-foreground">
          {routine.prompt}
        </p>
      </Section>
      <Section title="Recent sessions">
        <RoutineSessions projectId={projectId} routineId={routineId} />
      </Section>
    </div>
  );
}

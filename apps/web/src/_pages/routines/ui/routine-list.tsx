"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { Routine } from "@/entities/routine";
import { pageRoutinesQueryOptions } from "../api/routines";
import { routinePath } from "@/shared/lib/routine-path";
import { RequestState } from "@/widgets/request-state";
import { requestErrorStatus } from "@/shared/api";
import { modelLabel, triggerEvent } from "../model/routine-summary";

function RoutineItem({ routine }: { routine: Routine }) {
  return (
    <Link
      href={routinePath(routine.projectId, routine.id)}
      className="group flex flex-col gap-2.5 rounded-sm py-2.5"
    >
      <span className="truncate text-item-title font-semibold text-foreground group-hover:underline">
        {routine.name}
      </span>
      <span className="flex flex-wrap items-center gap-1.5 text-body text-muted-foreground">
        <span>{modelLabel(routine)}</span>
        <span
          aria-hidden="true"
          className="size-0.75 rounded-xs bg-muted-foreground"
        />
        <span>
          Issue on{" "}
          <span className="capitalize">{triggerEvent(routine.trigger)}</span>
        </span>
      </span>
    </Link>
  );
}

export function RoutineList({ projectId }: { projectId: string }) {
  const query = useQuery(pageRoutinesQueryOptions(projectId));
  if (query.isPending)
    return (
      <p role="status" className="text-caption text-muted-foreground">
        Loading routines…
      </p>
    );
  if (query.isError)
    return (
      <RequestState
        status={requestErrorStatus(query.error)}
        missing="This project is not available."
        retry={() => void query.refetch()}
      />
    );
  if (query.data.routines.length === 0)
    return (
      <p className="text-caption text-muted-foreground">
        No routines yet. Add one in{" "}
        <Link href="/projects" className="underline">
          Settings
        </Link>
        .
      </p>
    );
  return (
    <ul className="flex w-full flex-col divide-y divide-border">
      {query.data.routines.map((routine) => (
        <li key={routine.id}>
          <RoutineItem routine={routine} />
        </li>
      ))}
    </ul>
  );
}

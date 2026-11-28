"use client";

import { useQuery } from "@tanstack/react-query";
import { projectsQueryOptions } from "@/features/select-project";

export function ProjectName({ projectId }: { projectId: string }) {
  const { data } = useQuery(projectsQueryOptions());
  const name =
    data?.find((project) => project.id === projectId)?.name ?? projectId;
  return (
    <span
      title={name}
      className="flex h-8 min-w-0 flex-1 items-center truncate rounded-lg border px-2.5 text-control"
    >
      {name}
    </span>
  );
}

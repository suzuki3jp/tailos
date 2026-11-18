"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { homeProjectsQueryOptions } from "../api/queries";
import type { ProjectSelection } from "../model/project-selection";

const ProjectContext = createContext<{
  selection: ProjectSelection;
  error: Error | null;
  retry: () => void;
} | null>(null);

export function ProjectSelectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const query = useQuery(homeProjectsQueryOptions());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const projects = query.isError ? [] : (query.data ?? []);
  const selection = {
    projects,
    value:
      projects.find((project) => project.id === selectedId)?.id ??
      projects[0]?.id ??
      null,
    onValueChange: setSelectedId,
    disabled: query.isError || projects.length === 0,
  };
  return (
    <ProjectContext
      value={{
        selection,
        error: query.error,
        retry: () => void query.refetch(),
      }}
    >
      {children}
    </ProjectContext>
  );
}

export function useProjectSelection() {
  const context = useContext(ProjectContext);
  if (!context) throw new Error("Project selection requires its provider");
  return context;
}

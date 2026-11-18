"use client";

import Link from "next/link";
import { DataRequestState } from "./data-request-state";
import { useProjectSelection } from "./project-selection";

export function ProjectStatus() {
  const { selection, error, retry } = useProjectSelection();
  if (error) return <DataRequestState error={error} retry={retry} />;
  if (selection.projects.length === 0)
    return (
      <p className="text-caption text-muted-foreground">
        No projects yet.{" "}
        <Link href="/projects" className="underline">
          Manage projects
        </Link>
      </p>
    );
  return null;
}

"use client";

import { Select } from "@/shared/ui/design-systems";
import type { ProjectSelection } from "../model/project-selection";
import { useProjectSelection } from "./project-selection";

export function CurrentProjectSelect({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { selection } = useProjectSelection();
  return <ProjectSelect compact={compact} {...selection} />;
}

export function ProjectSelect({
  compact = false,
  projects,
  value,
  onValueChange,
  disabled,
}: ProjectSelection & { compact?: boolean }) {
  return (
    <Select
      aria-label={compact ? "Loop project" : "Current project"}
      options={projects.map(({ id, name, repository }) => ({
        id,
        label: name,
        description: repository,
      }))}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      size={compact ? "xs" : "default"}
      variant={compact ? "ghost" : "outline"}
      className={compact ? "w-35" : "flex-1"}
      placeholder="No projects"
      placement="bottom start"
      popoverClassName="min-w-64 max-w-[calc(100vw-2rem)]"
      optionsLang="en"
    />
  );
}

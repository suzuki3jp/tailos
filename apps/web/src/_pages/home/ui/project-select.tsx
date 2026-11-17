"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import type { HomeProject } from "../api/queries";

export type ProjectSelection = {
  projects: HomeProject[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  loading: boolean;
  disabled: boolean;
};

export function ProjectSelect({
  compact = false,
  projects,
  value,
  onValueChange,
  loading,
  disabled,
}: ProjectSelection & { compact?: boolean }) {
  const items = projects.map((project) => ({
    value: project.id,
    label: project.name,
  }));
  const label = compact ? "Loop project" : "Current project";

  return (
    <Select
      items={items}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={label}
        size={compact ? "xs" : "default"}
        variant={compact ? "ghost" : "outline"}
        className={compact ? "w-35" : "min-w-0 flex-1"}
      >
        <SelectValue
          placeholder={loading ? "Loading projects…" : "No projects"}
        />
      </SelectTrigger>
      <SelectContent
        lang="en"
        alignItemWithTrigger={false}
        align="start"
        className="min-w-64 max-w-[calc(100vw-2rem)]"
      >
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            <span className="flex min-w-0 flex-col gap-1 whitespace-normal wrap-anywhere">
              <span>{project.name}</span>
              <span className="text-xs text-muted-foreground">
                {project.repository}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

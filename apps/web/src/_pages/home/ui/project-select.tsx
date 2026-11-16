"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { homePreview } from "../model/preview";

export function ProjectSelect({ compact = false }: { compact?: boolean }) {
  const items = homePreview.projects.map((project) => ({
    value: project.id,
    label: project.name,
  }));
  const label = compact
    ? "Loop project (preview)"
    : "Current project (preview)";

  return (
    <Select items={items} defaultValue={items[0].value}>
      <SelectTrigger
        aria-label={label}
        size={compact ? "xs" : "default"}
        variant={compact ? "ghost" : "outline"}
        className={compact ? "w-35" : "min-w-0 flex-1"}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

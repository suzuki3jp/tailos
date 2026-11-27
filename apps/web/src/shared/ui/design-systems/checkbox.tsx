"use client";

import { IconCheck } from "@tabler/icons-react";
import { Checkbox as AriaCheckbox } from "react-aria-components/Checkbox";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Checkbox({
  className,
  children,
  ...props
}: Omit<
  ComponentProps<typeof AriaCheckbox>,
  "className" | "children" | "render" | "isIndeterminate"
> & {
  className?: string;
  children: ReactNode;
}) {
  return (
    <AriaCheckbox
      {...props}
      className={cn(
        "group/checkbox inline-flex cursor-pointer items-center gap-2 text-sm data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="grid size-4 shrink-0 place-items-center rounded-sm border border-input bg-background text-primary-foreground group-data-selected/checkbox:border-primary group-data-selected/checkbox:bg-primary group-data-focus-visible/checkbox:ring-2 group-data-focus-visible/checkbox:ring-ring group-data-focus-visible/checkbox:ring-offset-2"
      >
        <IconCheck className="invisible size-3 group-data-selected/checkbox:visible" />
      </span>
      {children}
    </AriaCheckbox>
  );
}

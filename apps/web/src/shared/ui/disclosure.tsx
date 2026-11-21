"use client";

import type { ReactNode } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { cn } from "../lib/cn";

export function Disclosure({
  label,
  children,
  open,
  onOpenChange,
  className,
  inlineChevron = false,
}: {
  label: ReactNode;
  children: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  className?: string;
  inlineChevron?: boolean;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      className={cn("[&[open]>summary>svg]:rotate-90", className)}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center rounded-sm text-control marker:hidden [&::-webkit-details-marker]:hidden",
          inlineChevron ? "gap-1.5" : "gap-2",
        )}
      >
        <span className={cn("min-w-0", !inlineChevron && "flex-1")}>
          {label}
        </span>
        <IconChevronRight
          aria-hidden="true"
          size={16}
          className="shrink-0 transition-transform motion-reduce:transition-none"
        />
      </summary>
      {open && children}
    </details>
  );
}

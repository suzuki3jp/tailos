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
}: {
  label: ReactNode;
  children: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  className?: string;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      className={cn("[&[open]>summary>svg]:rotate-90", className)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-control marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">{label}</span>
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

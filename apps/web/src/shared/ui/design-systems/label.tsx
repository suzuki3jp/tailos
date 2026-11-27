"use client";

import { Label as AriaLabel } from "react-aria-components/Label";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

export function Label({
  className,
  ...props
}: Omit<ComponentProps<typeof AriaLabel>, "className" | "render"> & {
  className?: string;
}) {
  return (
    <AriaLabel
      {...props}
      className={cn("block space-y-2 text-sm", className)}
    />
  );
}

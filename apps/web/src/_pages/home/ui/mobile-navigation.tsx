"use client";

import { useState, type ReactNode } from "react";
import { IconMenu2 } from "@tabler/icons-react";
import { Button } from "@/shared/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/shared/ui/sheet";

export function MobileNavigation({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open navigation"
          />
        }
      >
        <IconMenu2 aria-hidden="true" />
      </SheetTrigger>
      <SheetContent
        lang="en"
        side="left"
        showCloseButton={false}
        className="gap-0 bg-sidebar p-0 data-[side=left]:w-60"
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("a[href]")
          )
            setOpen(false);
        }}
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SheetDescription className="sr-only">
          Choose a project or open a Tailos page.
        </SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}

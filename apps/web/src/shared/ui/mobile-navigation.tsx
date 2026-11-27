"use client";

import { useState, type ReactNode } from "react";
import { IconMenu2 } from "@tabler/icons-react";
import { Button, Dialog, SheetContent } from "./design-systems";

export function MobileNavigation({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog isOpen={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Open navigation"
      >
        <IconMenu2 aria-hidden="true" />
      </Button>
      <SheetContent
        lang="en"
        side="left"
        title="Navigation"
        description="Open a Tailos page."
        hideHeading
        showCloseButton={false}
        className="w-60 gap-0 bg-sidebar"
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("a[href]")
          )
            setOpen(false);
        }}
      >
        {children}
      </SheetContent>
    </Dialog>
  );
}

"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/shared/ui/resizable";

// Match the lg breakpoint used by the project navigation.
const desktopQuery = "(min-width: 64rem)";

function subscribeToBreakpoint(onChange: () => void) {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function SessionPanels({
  children,
  sessions,
}: {
  children: ReactNode;
  sessions: ReactNode;
}) {
  const showSessions = useSyncExternalStore(
    subscribeToBreakpoint,
    () => window.matchMedia(desktopQuery).matches,
    () => true,
  );

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 flex-1 max-lg:[&>#project-sessions]:hidden!"
    >
      <ResizablePanel className="flex min-w-0 flex-col">
        {children}
      </ResizablePanel>
      {showSessions && (
        <>
          <ResizableHandle
            aria-label="Resize session list"
            disableDoubleClick
            className="max-lg:hidden data-[separator=hover]:bg-primary/60 data-[separator=active]:bg-primary"
          />
          <ResizablePanel
            id="project-sessions"
            tabIndex={-1}
            defaultSize={240}
            minSize={160}
            maxSize={384}
            groupResizeBehavior="preserve-pixel-size"
          >
            <aside aria-label="Project sessions">{sessions}</aside>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

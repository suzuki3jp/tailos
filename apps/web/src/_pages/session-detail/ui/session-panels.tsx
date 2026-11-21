"use client";

import {
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePanelRef } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/shared/ui/resizable";

// Match the lg breakpoint used by the project navigation.
const desktopQuery = "(min-width: 64rem)";
const sessionListPanelId = "project-sessions";
const sessionListWidthKey = "tailos:session-list-width";
const minSessionListWidth = 160;
const maxSessionListWidth = 384;

function readSessionListWidth() {
  try {
    const width = Number(window.localStorage.getItem(sessionListWidthKey));
    if (width >= minSessionListWidth && width <= maxSessionListWidth) {
      return width;
    }
  } catch {
    // The panel can still be resized when browser storage is unavailable.
  }
}

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
  const sessionListPanel = usePanelRef();
  const panelGroup = useRef<HTMLDivElement>(null);
  const resizeHandle = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!showSessions || !window.matchMedia(desktopQuery).matches) {
      return;
    }
    const width = readSessionListWidth();
    if (width === undefined) {
      return;
    }

    // Wait for a newly mounted panel to register its constraints with the group.
    const frame = requestAnimationFrame(() => {
      sessionListPanel.current?.resize(width);
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionListPanel, showSessions]);

  return (
    <ResizablePanelGroup
      elementRef={panelGroup}
      orientation="horizontal"
      onLayoutChanged={(layout, { isUserInteraction }) => {
        const percentage = layout[sessionListPanelId];
        if (
          !isUserInteraction ||
          percentage === undefined ||
          !panelGroup.current ||
          !resizeHandle.current
        ) {
          return;
        }

        // The callback can run before the new panel width is applied to the DOM.
        const availableWidth =
          panelGroup.current.clientWidth - resizeHandle.current.offsetWidth;
        const width = Math.round((percentage / 100) * availableWidth);
        if (width >= minSessionListWidth && width <= maxSessionListWidth) {
          try {
            window.localStorage.setItem(sessionListWidthKey, String(width));
          } catch {
            // The current layout still works when the preference cannot be saved.
          }
        }
      }}
      className="min-h-0 flex-1 max-lg:[&>#project-sessions]:hidden!"
    >
      <ResizablePanel className="flex min-w-0 flex-col">
        {children}
      </ResizablePanel>
      {showSessions && (
        <>
          <ResizableHandle
            elementRef={resizeHandle}
            aria-label="Resize session list"
            disableDoubleClick
            className="max-lg:hidden data-[separator=hover]:bg-primary/60 data-[separator=active]:bg-primary"
          />
          <ResizablePanel
            id={sessionListPanelId}
            panelRef={sessionListPanel}
            tabIndex={-1}
            defaultSize={240}
            minSize={minSessionListWidth}
            maxSize={maxSessionListWidth}
            groupResizeBehavior="preserve-pixel-size"
          >
            <aside aria-label="Project sessions">{sessions}</aside>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

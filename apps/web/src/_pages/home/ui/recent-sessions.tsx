"use client";

import { IconMessage, IconMessageDots } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { homePreview, type PreviewSession } from "../model/preview";

function SessionRow({
  session,
  separator,
}: {
  session: PreviewSession;
  separator: boolean;
}) {
  return (
    <Dialog>
      <DialogTrigger className="relative flex min-h-16 w-full flex-col gap-1.5 p-3 text-left hover:bg-accent">
        {separator && (
          <span className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden">
            <img
              src="/assets/design-system/separator.svg"
              alt=""
              width={640}
              height={1}
              className="max-w-none"
            />
          </span>
        )}
        <span className="flex w-full items-center gap-3">
          <span className="relative size-5 shrink-0">
            {session.state === "running" ? (
              <IconMessageDots
                aria-hidden="true"
                size={20}
                className="text-foreground-strong"
              />
            ) : (
              <IconMessage
                aria-hidden="true"
                size={20}
                className="text-foreground-strong"
              />
            )}
            {session.unread && (
              <img
                src="/assets/design-system/unread.svg"
                alt="Unread"
                width={6}
                height={6}
                className="absolute top-0 left-4"
              />
            )}
          </span>
          <span className="min-w-0 text-body wrap-anywhere text-foreground-strong">
            {session.title}
          </span>
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-1.5 pl-9 text-caption text-muted-foreground">
          <span>triggered by issue #{session.issueNumber}</span>
          <span>{session.updatedLabel}</span>
        </span>
      </DialogTrigger>
      <DialogContent lang="en">
        <DialogHeader className="pr-6">
          <DialogTitle>{session.title}</DialogTitle>
          <DialogDescription>
            Sample session · issue #{session.issueNumber}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This session is part of the home preview. No live session or run is
          connected.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export function RecentSessions() {
  return (
    <section
      id="recent-sessions"
      aria-labelledby="recent-sessions-heading"
      className="scroll-mt-6"
    >
      <h2
        id="recent-sessions-heading"
        className="text-section-title font-semibold text-foreground-strong"
      >
        Recent Sessions
      </h2>
      <div className="mt-2.5 overflow-hidden rounded-sm">
        {homePreview.sessions.map((session, index) => (
          <SessionRow
            key={session.id}
            session={session}
            separator={index !== 0}
          />
        ))}
      </div>
    </section>
  );
}

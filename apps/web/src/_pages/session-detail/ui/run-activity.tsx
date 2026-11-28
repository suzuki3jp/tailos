"use client";

import Link from "next/link";
import { useState } from "react";
import type { TimelineItem } from "@tailos/core/timeline";
import { Disclosure } from "@/shared/ui/disclosure";
import type { SessionRun } from "../api/queries";
import { runActivityLabel } from "../model/activity";
import { runResult } from "../model/run-result";
import { isActiveRun } from "../api/queries";
import { ActivityItem, ActivityMark } from "./activity-item";

export function RunActivity({
  run,
  items = [],
  sessionId,
  projectId,
  capture,
}: {
  run: SessionRun;
  items?: TimelineItem[];
  sessionId: string;
  projectId?: string;
  capture?: { state: string; dropped: number };
}) {
  const active = isActiveRun(run);
  const [open, setOpen] = useState(active);
  const { urls, plan } = runResult(run.result);
  return (
    <div className="space-y-2">
      <Disclosure
        inlineChevron
        summaryClassName="rounded-none border-b border-muted-foreground pb-1"
        open={open}
        onOpenChange={setOpen}
        label={
          <span className="flex items-center gap-2 text-muted-foreground">
            {active && <ActivityMark status="running" />}
            {active &&
            items.some(
              (item) =>
                item.kind === "stage" &&
                item.label === "agent" &&
                item.finishedAt !== null,
            )
              ? "Finishing…"
              : runActivityLabel(run)}
          </span>
        }
      >
        <div
          className="mt-3 space-y-3 border-l border-border pl-3"
          aria-label="Execution history"
        >
          {items.map((item) => (
            <ActivityItem
              key={item.id}
              item={item}
              sessionId={sessionId}
              projectId={projectId}
              runActive={active}
            />
          ))}
          {!items.length && (
            <p className="text-control text-muted-foreground">
              {active
                ? "Waiting for Agent updates…"
                : "No execution history is available."}
            </p>
          )}
          {capture &&
            (capture.state === "partial" ||
              capture.state === "unknown" ||
              capture.dropped > 0) && (
              <p className="text-control text-muted-foreground">
                Some execution details are missing.
                {capture.dropped > 0 && ` ${capture.dropped} records omitted.`}
              </p>
            )}
        </div>
      </Disclosure>
      {(run.errorCode || plan || urls) && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {run.errorCode && (
            <span className="wrap-anywhere text-destructive">
              {run.errorCode}
            </span>
          )}
          {plan && <span>{plan}</span>}
          {urls?.map((url) => (
            <Link key={url} className="underline" href={url}>
              {urls.length > 1
                ? `Open pull request #${url.split("/").pop()}`
                : "Open pull request"}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

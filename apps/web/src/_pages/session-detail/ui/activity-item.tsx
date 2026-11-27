"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  IconCheck,
  IconCircleDashed,
  IconQuestionMark,
  IconX,
} from "@tabler/icons-react";
import type { TimelineItem } from "@tailos/core/timeline";
import { Button } from "@/shared/ui/design-systems";
import { Disclosure } from "@/shared/ui/disclosure";
import { timelineOutputOptions, TimelineRequestError } from "../api/timeline";
import { timelineInput, timelineOutput } from "../model/timeline";

const kinds = {
  message: "Agent update",
  command: "Command",
  web: "Web search",
  tool: "Tool call",
  file: "File changes",
  stage: "Execution",
};
const stages: Record<string, string> = {
  checkout: "Checking out repository",
  continuity: "Carrying over work",
  agent: "Agent",
  publication: "Publishing",
  commit: "Creating commit",
  pull_request: "Creating pull request",
  cleanup: "Cleaning up",
};
const statusLabels = {
  running: "Running…",
  succeeded: "Completed",
  failed: "Failed",
  unknown: "Result unknown",
} satisfies Record<TimelineItem["status"], string>;
const statusIcons = {
  running: IconCircleDashed,
  succeeded: IconCheck,
  failed: IconX,
  unknown: IconQuestionMark,
};

export function ActivityMark({ status }: { status: TimelineItem["status"] }) {
  const Icon = statusIcons[status];
  return (
    <Icon
      aria-hidden="true"
      size={16}
      className={
        status === "running" ? "shrink-0 motion-safe:animate-spin" : "shrink-0"
      }
    />
  );
}

export function ActivityItem({
  item,
  sessionId,
  projectId,
  runActive,
}: {
  item: TimelineItem;
  sessionId: string;
  projectId?: string;
  runActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expired = item.bodyExpiresAt <= Date.now();
  const status =
    item.status === "running" && !runActive ? "unknown" : item.status;
  const output = useQuery({
    ...timelineOutputOptions(projectId, sessionId, item.id, item.revision),
    enabled: open && !expired && (item.hasInput || item.hasOutput),
  });
  const title =
    item.kind === "stage"
      ? (stages[item.label ?? ""] ?? kinds.stage)
      : (item.label ?? kinds[item.kind]);
  function renderOutput() {
    if (
      expired ||
      (output.error instanceof TimelineRequestError &&
        output.error.status === 410)
    )
      return <p className="text-muted-foreground">This output has expired.</p>;
    if (output.isError)
      return (
        <div>
          <p>Output could not be loaded.</p>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => void output.refetch()}
          >
            Retry
          </Button>
        </div>
      );
    if (output.isFetching)
      return (
        <p role="status" className="text-muted-foreground">
          Loading output…
        </p>
      );
    if (output.data)
      return (
        <>
          {output.data.input && (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-control-xs whitespace-pre-wrap wrap-anywhere">
              {timelineInput(output.data.input)}
            </pre>
          )}
          {output.data.output && (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-control-xs whitespace-pre-wrap wrap-anywhere">
              {timelineOutput(output.data.output)}
            </pre>
          )}
          {!output.data.input && !output.data.output && (
            <p className="text-muted-foreground">No output was captured.</p>
          )}
          {status === "running" && !item.hasOutput && (
            <p className="text-muted-foreground">
              Output is available after completion.
            </p>
          )}
        </>
      );
    return (
      <p className="text-muted-foreground">
        {status === "running"
          ? "Output is available after completion."
          : "No output was captured."}
      </p>
    );
  }
  if (item.kind === "message" && item.text && !expired)
    return (
      <p className="whitespace-pre-wrap wrap-anywhere text-control leading-relaxed">
        {item.text}
      </p>
    );
  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-card px-3 py-2.5"
      label={
        <span
          className={`flex min-w-0 items-start gap-2 ${status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
        >
          <ActivityMark status={status} />
          <span className="min-w-0 flex-1 space-y-1">
            <span
              className={`block wrap-anywhere ${item.kind === "command" ? "font-mono" : ""}`}
            >
              {title}
            </span>
            <span className="block text-control-xs">
              {statusLabels[status]}
              {item.exitCode !== null && ` · Exit ${item.exitCode}`}
              {item.durationMs !== null &&
                ` · ${(item.durationMs / 1000).toFixed(1)}s`}
            </span>
          </span>
        </span>
      }
    >
      <div className="mt-3 space-y-3 text-control">{renderOutput()}</div>
    </Disclosure>
  );
}

import type { DiagnosticRecord } from "@tailos/core/diagnostics";
import {
  timelineInlineBytes,
  type TimelineItem,
  type TimelineSnapshot,
  type TimelineChanges,
} from "@tailos/core/timeline";

export interface TimelineReader {
  owned(
    sessionId: string,
    ownerId: string,
    projectId?: string,
  ): Promise<boolean>;
  snapshot(sessionId: string, before?: number): Promise<TimelineSnapshot>;
  changes(sessionId: string, after: number): Promise<TimelineChanges | null>;
  output(
    sessionId: string,
    itemId: string,
  ): Promise<{
    input: string | null;
    output: string | null;
    expired: boolean;
  } | null>;
}

function bodyObject(body?: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body ?? "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function inline(value: unknown) {
  return typeof value === "string" &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      timelineInlineBytes
    ? value
    : null;
}

function observationStatus(record: DiagnosticRecord): TimelineItem["status"] {
  if (record.name !== "span.finished") return "running";
  if (record.attributes.outcome === "succeeded") return "succeeded";
  if (record.attributes.outcome === "failed") return "failed";
  return "unknown";
}

// Called only after whole-record redaction. Raw provider messages never reach
// the browser contract, and final/unknown-phase replies remain conversation data.
export function timelineObservation(record: DiagnosticRecord) {
  const operation = record.attributes.operation;
  let kind: TimelineItem["kind"];
  switch (operation) {
    case "reply":
      if (
        record.attributes.messagePhase !== "commentary" ||
        record.name !== "span.finished"
      )
        return null;
      kind = "message";
      break;
    case "command":
      kind = "command";
      break;
    case "tool":
      kind = record.attributes.toolKind === "web" ? "web" : "tool";
      break;
    case "file_change":
      kind = "file";
      break;
    case "checkout":
    case "continuity":
    case "agent":
    case "publication":
    case "commit":
    case "pull_request":
    case "cleanup":
      kind = "stage";
      break;
    default:
      return null;
  }
  if (record.name !== "span.started" && record.name !== "span.finished")
    return null;
  const body = bodyObject(record.body);
  const finished = record.name === "span.finished";
  return {
    kind,
    label:
      kind === "stage"
        ? (operation ?? null)
        : inline(body.command ?? body.tool ?? body.name ?? body.query),
    text: kind === "message" ? inline(body.text) : null,
    status: observationStatus(record),
    finishedAt: finished ? record.at : null,
    durationMs: record.attributes.durationMs ?? null,
    exitCode: record.attributes.exitCode ?? null,
  };
}

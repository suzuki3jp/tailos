import type { DiagnosticReader } from "@/application/diagnostics/store.ts";

export type Position = { createdAt: number; id: string };
export type Page<T> = { items: T[]; nextCursor: Position | null };
export type SessionSummary = {
  id: string;
  projectId: string | null;
  target: string | null;
  createdAt: number;
};
export type RunSummary = {
  id: string;
  sessionId: string;
  startMessageId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  errorCode: string | null;
  createdAt: number;
  finishedAt: number | null;
  deadlineAt: number;
};
export type MessageSummary = {
  id: string;
  seq: number;
  authorKind: "user" | "automation" | "agent";
  runId: string | null;
  createdAt: number;
  body: string;
  bodyLength: number;
};

// Every adapter operation receives the authenticated owner, including reads
// of an ID obtained from another tool. No storage keys cross this boundary.
export type InspectionStore = {
  diagnostics: Omit<DiagnosticReader, "body">;
  readDiagnosticArtifact(
    ownerId: string,
    artifactId: string,
    offset: number,
    limit: number,
  ): Promise<
    | {
        state: "available";
        text: string;
        nextOffset: number | null;
        totalLength: number;
      }
    | { state: "not_found" | "expired" | "unreadable" }
  >;
  listSessions(
    ownerId: string,
    input: {
      projectId?: string;
      target?: string;
      before?: Position;
      limit: number;
    },
  ): Promise<Page<SessionSummary>>;
  getSession(
    ownerId: string,
    id: string,
    afterSeq: number,
    limit: number,
  ): Promise<{
    session: SessionSummary;
    messages: MessageSummary[];
    nextAfterSeq: number | null;
  } | null>;
  readMessage(
    ownerId: string,
    id: string,
    offset: number,
    limit: number,
  ): Promise<{
    text: string;
    nextOffset: number | null;
    totalLength: number;
  } | null>;
  listRuns(
    ownerId: string,
    input: {
      sessionId?: string;
      status?: RunSummary["status"];
      before?: Position;
      limit: number;
    },
  ): Promise<Page<RunSummary>>;
  getRun(
    ownerId: string,
    id: string,
  ): Promise<(RunSummary & { result: string | null }) | null>;
  readRunArtifact(
    ownerId: string,
    runId: string,
    file: "events.ndjson" | "result.json",
  ): Promise<
    | { state: "available"; text: string }
    | { state: "not_found" | "not_ready" | "unavailable" | "unreadable" }
  >;
};

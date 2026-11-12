import type { DiagnosticAttributes } from "@tailos/core/diagnostics";

export type TriggerDiagnostic = {
  traceId: string;
  requestId: string;
  source: string;
  deliveryId?: string;
  reason: NonNullable<DiagnosticAttributes["reason"]>;
  outcome?: "ignored" | "failed" | "unknown";
};

export type DiagnosticTraceView = {
  id: string;
  runId: string | null;
  sessionId: string | null;
  source: string;
  deliveryId: string | null;
  requestId: string | null;
  createdAt: number;
  captureState: string;
  dropped: number;
  runStatus: string | null;
};
export type DiagnosticEventView = {
  cursor: number;
  eventId: string;
  spanId: string;
  parentSpanId: string | null;
  producerId: string;
  producerSeq: number | null;
  requestId: string | null;
  occurredAt: number;
  receivedAt: number;
  name: string;
  attributes: Record<string, unknown>;
  artifactId: string | null;
};
export type DiagnosticArtifactView = {
  cursor: number;
  id: string;
  spanId: string;
  bytes: number;
  expiresAt: number;
};

export interface DiagnosticReader {
  traces(
    ownerId: string,
    filter: {
      runId?: string;
      source?: string;
      deliveryId?: string;
      before?: { at: number; id: string };
    },
  ): Promise<{ traces: DiagnosticTraceView[]; nextCursor: string | null }>;
  events(
    ownerId: string,
    traceId: string,
    after: number,
  ): Promise<{ events: DiagnosticEventView[]; nextCursor: number } | null>;
  artifacts(
    ownerId: string,
    traceId: string,
    after?: number,
  ): Promise<{
    artifacts: DiagnosticArtifactView[];
    nextCursor: number;
  } | null>;
  body(ownerId: string, artifactId: string): Promise<Response | null>;
}

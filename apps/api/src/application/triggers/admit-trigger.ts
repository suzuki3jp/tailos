export type TriggerAdmission = {
  source: string;
  deliveryId?: string;
  idempotencyKey: string;
  ownerId: string;
  projectId?: string;
  projectRevision?: number;
  target?: string;
  initialTitle?: string;
  triggerMetadata?: string;
  concurrencyKey: string;
  /** Who wrote the first message; external events default to automation. */
  authorKind?: "automation" | "user";
  prompt: string;
  executionContext: string;
  timeoutMs: number;
  diagnostics?: { traceId: string; requestId: string };
};

export type Admission = {
  sessionId: string;
  runId: string;
  disposition: "started" | "coalesced";
};

export type AdmitTrigger = (input: TriggerAdmission) => Promise<Admission>;

/**
 * A message from a Routine started on an issue. The Routine keeps one Session
 * per issue: the message goes to it, and waits there while a Turn is in
 * progress.
 */
export type IssueMessage = {
  source: "github.issue-label" | "github.issue-comment";
  idempotencyKey: string;
  deliveryId: string;
  ownerId: string;
  projectId: string;
  projectRevision: number;
  routineId: string;
  routineRevision: number;
  repositoryId: number;
  issueNumber: number;
  /** A message that only continues a Session needs the Session to exist. */
  startsSession: boolean;
  initialTitle: string;
  triggerMetadata: string;
  target: string;
  body: string;
  executionContext: string;
  timeoutMs: number;
  diagnostics?: { traceId: string; requestId: string };
};
export type IssueMessageReceipt = {
  sessionId: string;
  /** Absent while the message waits for the Session's current Turn. */
  runId?: string;
  disposition: "started" | "queued";
  /** A Turn this admission created, which the caller schedules. */
  started?: string;
};
/** Null when the message continues a Session that does not exist. */
export type AdmitIssueMessage = (
  input: IssueMessage,
) => Promise<IssueMessageReceipt | null>;
export class ProjectChanged extends Error {}

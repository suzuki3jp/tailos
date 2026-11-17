export type TriggerAdmission = {
  source: string;
  idempotencyKey: string;
  ownerId: string;
  projectId?: string;
  projectRevision?: number;
  target?: string;
  initialTitle?: string;
  triggerMetadata?: string;
  concurrencyKey: string;
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
export class ProjectChanged extends Error {}

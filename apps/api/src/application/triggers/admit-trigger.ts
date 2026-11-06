export type TriggerAdmission = {
  source: string;
  idempotencyKey: string;
  ownerId: string;
  projectId?: string;
  target?: string;
  concurrencyKey: string;
  prompt: string;
  executionContext: string;
  timeoutMs: number;
};

export type Admission = {
  sessionId: string;
  runId: string;
  disposition: "started" | "coalesced";
};

export type AdmitTrigger = (input: TriggerAdmission) => Promise<Admission>;

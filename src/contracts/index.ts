// Serializable contracts shared by the control plane and disposable runners.
// No provider SDKs, platform bindings, or secret storage details belong here.
export interface Project {
  id: string;
  repository: string;
  installationId: number;
  triggerLabel: string;
  allowedActors: string[];
  engine: string;
  connectionId: string;
  model?: string;
  baseBranch?: string;
  maxRunMinutes: number;
  setupCommands: string[];
  testCommands: string[];
}
export interface ExecutionRequest {
  source: string;
  deliveryId: string;
  repository: string;
  issueNumber: number;
  actor: string;
}
export interface IssueContext {
  title: string;
  body: string;
  url: string;
  baseBranch: string;
  baseSha: string;
  baseTree: string;
}
export interface AccessGrant {
  accessToken: string;
  accountId: string;
  planType?: string;
  expiresAt: number;
  connectionVersion: string;
}
export interface AgentEvent {
  seq: number;
  time: string;
  type: string;
  data: unknown;
}
export interface FileChange {
  path: string;
  mode: '100644' | '100755' | '120000';
  contentBase64: string | null;
}
export interface AgentResult {
  sessionId?: string;
  summary: string;
  changes: FileChange[];
}
export interface RunnerJob {
  runId: string;
  engine: string;
  repository: string;
  issue: IssueContext;
  model?: string;
  setupCommands: string[];
  testCommands: string[];
  deadline: number;
  access: AccessGrant;
  refresh: { url: string; bearer: string };
}
export interface JobStatus {
  state: 'running' | 'succeeded' | 'failed';
  events: AgentEvent[];
  lastSeq: number;
  result?: AgentResult;
  error?: string;
}
export type RunPhase = 'queued' | 'starting' | 'running' | 'publishing' | 'succeeded' | 'no_changes' | 'failed' | 'cancelled';
export interface Run {
  id: string;
  project: Project;
  request: ExecutionRequest;
  phase: RunPhase;
  createdAt: number;
  deadline: number;
  issue?: IssueContext;
  connectionVersion?: string;
  lastSeq: number;
  recentEvents: AgentEvent[];
  result?: AgentResult;
  pullRequestUrl?: string;
  error?: string;
}
export const isTerminal = (phase: RunPhase) => ['succeeded', 'no_changes', 'failed', 'cancelled'].includes(phase);

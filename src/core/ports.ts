import type { AccessGrant, AgentEvent, AgentResult, ExecutionRequest, IssueContext, JobStatus, Project, RunnerJob } from '../contracts/index';

export interface TriggerAdapter<Input> {
  normalize(input: Input): Promise<ExecutionRequest | null>;
}
export interface DeviceChallenge {
  kind: 'device';
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: number;
  opaque: string;
}
export interface RedirectChallenge {
  kind: 'redirect';
  authorizationUrl: string;
  expiresAt: number;
  opaque: string;
}
export type AuthChallenge = DeviceChallenge | RedirectChallenge;
// Each provider owns its credential representation (OAuth, API key, native cache, ...).
// Core does not require every provider to have an OIDC ID token or a refresh token.
export interface AuthAdapter<Credentials> {
  readonly id: string;
  begin(): Promise<AuthChallenge>;
  complete(challenge: AuthChallenge, callback?: Record<string, string>): Promise<Credentials | null>;
  refresh(credentials: Credentials): Promise<Credentials>;
}
export interface CredentialProvider {
  acquire(connectionId: string, version?: string): Promise<AccessGrant>;
}
export interface SourceRepository {
  loadIssue(project: Project, request: ExecutionRequest): Promise<IssueContext>;
  publish(project: Project, request: ExecutionRequest, issue: IssueContext, runId: string, result: AgentResult): Promise<string>;
}
export interface SandboxProvider {
  start(job: RunnerJob): Promise<void>;
  poll(runId: string, after: number): Promise<JobStatus>;
  destroy(runId: string): Promise<void>;
}
export interface AgentAdapter {
  readonly id: string;
  run(job: RunnerJob, context: {
    cwd: string;
    signal: AbortSignal;
    emit(type: string, data: unknown): void;
    refresh(): Promise<AccessGrant>;
  }): Promise<{ sessionId?: string; summary: string }>;
}
export interface EventArchive {
  append(runId: string, events: AgentEvent[]): Promise<void>;
  result(runId: string, result: AgentResult): Promise<void>;
}

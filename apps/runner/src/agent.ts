import type { RunnerJob } from "@tailos/core/runner";

export type AgentResult = { reply: string; headline?: string };

export interface AgentAdapter {
  run(job: RunnerJob, signal: AbortSignal, cwd?: string): Promise<AgentResult>;
}

export class AgentSandboxUnavailable extends Error {}
export class PublicationFailed extends Error {
  constructor(
    readonly code:
      | "format_check_failed"
      | "lint_failed"
      | "invalid_change_headline"
      | "unsupported_changes",
  ) {
    super(code);
  }
}

export const fakeAgent: AgentAdapter = {
  async run(job, signal) {
    signal.throwIfAborted();
    return { reply: `Fake agent completed: ${job.prompt}` };
  },
};

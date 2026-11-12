import type { RunnerJob } from "@tailos/core/runner";
import type { Diagnostics } from "@tailos/core/diagnostics";

export type AgentResult = { reply: string; headline?: string };

export interface AgentAdapter {
  run(
    job: RunnerJob,
    signal: AbortSignal,
    cwd?: string,
    diagnostics?: Diagnostics,
  ): Promise<AgentResult>;
}

export class AgentSandboxUnavailable extends Error {}
export class PublicationFailed extends Error {
  constructor(
    readonly code: "invalid_change_headline" | "unsupported_changes",
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

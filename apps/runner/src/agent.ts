import type { RunnerJob } from "@meguri/core/runner";

export interface AgentAdapter {
  run(job: RunnerJob, signal: AbortSignal, cwd?: string): Promise<string>;
}

export class AgentSandboxUnavailable extends Error {}

export const fakeAgent: AgentAdapter = {
  async run(job, signal) {
    signal.throwIfAborted();
    return `Fake agent completed: ${job.prompt}`;
  },
};

import type { RunnerJob } from "@tailos/core/runner";
import type { Diagnostics } from "@tailos/core/diagnostics";
import type { SavedConversation } from "@/continuity.ts";

export type AgentResult = {
  reply: string;
  sessionTitle?: string;
};

/**
 * The Agent's conversation across the Turns of a Session. `resume` continues
 * the previous Turn's conversation; `lost` says the previous Turn's work could
 * not be carried over; `save` receives the conversation at the end of the
 * Turn, whether it succeeded or not.
 */
export type Conversation = {
  resume?: SavedConversation;
  lost?: boolean;
  save(conversation: SavedConversation): void;
};

export interface AgentAdapter {
  run(
    job: RunnerJob,
    signal: AbortSignal,
    cwd?: string,
    diagnostics?: Diagnostics,
    conversation?: Conversation,
    /** The work tree's git directory, which the Agent may write. */
    gitDir?: string,
  ): Promise<AgentResult>;
}

export class AgentSandboxUnavailable extends Error {}
export const fakeAgent: AgentAdapter = {
  async run(job, signal) {
    signal.throwIfAborted();
    return { reply: `Fake agent completed: ${job.prompt}` };
  },
};

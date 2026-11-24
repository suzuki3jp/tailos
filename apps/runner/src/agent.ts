import type {
  PlanResult,
  PublicationRefusal,
  PublishedWork,
  RunnerJob,
} from "@tailos/core/runner";
import type { Diagnostics } from "@tailos/core/diagnostics";
import type { SavedConversation } from "@/continuity.ts";

export type AgentResult = {
  reply: string;
  sessionTitle?: string;
  plan?: PlanResult;
};

/** What the publication tool did, in terms the Agent can act on. */
export type PublishOutcome =
  | ({ published: true } & PublishedWork)
  | {
      published: false;
      reason:
        | "no_changes"
        | "in_progress"
        | "invalid_change_headline"
        | "unsupported_changes"
        | PublicationRefusal["error"];
    };
/** Publishes the work tree with a Conventional Commits headline. */
export type Publish = (headline: unknown) => Promise<PublishOutcome>;

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
    publish?: Publish,
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

/** The controller refused a publication for a reason the Agent can act on. */
export class PublicationRefused extends Error {
  constructor(readonly code: PublicationRefusal["error"]) {
    super(code);
  }
}

export const fakeAgent: AgentAdapter = {
  async run(job, signal) {
    signal.throwIfAborted();
    return {
      reply: `Fake agent completed: ${job.prompt}`,
      ...(job.mode === "plan" && {
        plan: { planPresented: true, needsAnswer: false },
      }),
    };
  },
};

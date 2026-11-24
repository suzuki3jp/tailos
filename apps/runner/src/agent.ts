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
        | Exclude<PublicationRefusal["error"], "parent_moved">;
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
  /**
   * The Session's pull request was merged and its work moved onto the latest
   * default branch: what was not published yet was re-applied, or kept
   * aside at `kept` because it conflicts.
   */
  realigned?: { publishedSha: string; kept?: string };
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
  readonly code: PublicationRefusal["error"];
  /** With `parent_moved`, where the Session's branch is now. */
  readonly sha?: string;
  constructor(refusal: PublicationRefusal) {
    super(refusal.error);
    this.code = refusal.error;
    if ("sha" in refusal) this.sha = refusal.sha;
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

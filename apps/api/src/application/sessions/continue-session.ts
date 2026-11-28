import { supportsSelection, type AgentEngine } from "@tailos/core/models";
import { ExecutionContext } from "@tailos/core/runner";
import * as v from "valibot";
import type { AgentConnected } from "@/application/auth/agent-connection.ts";
import type { ProjectRecord } from "@/application/projects/store.ts";
import { ProjectChanged } from "@/application/triggers/admit-trigger.ts";

/** The owner's message for a Session, with the settings of its next Turn. */
export type SessionMessage = {
  ownerId: string;
  projectId: string;
  projectRevision: number;
  sessionId: string;
  /** Issued by the client per message so a resend returns the first result. */
  requestId: string;
  body: string;
  executionContext: string;
  timeoutMs: number;
};

export type ContinueSessionInput = {
  ownerId: string;
  projectId: string;
  sessionId: string;
  /** Issued by the client per message so a resend returns the first result. */
  requestId: string;
  message: string;
  /**
   * The Model Provider the client chose. The Session keeps its own: a
   * different one is refused.
   */
  engine?: AgentEngine;
  model?: string;
  effort?: string;
};

export type ContinueSessionResult =
  | { status: "started"; runId: string }
  | { status: "busy" }
  | { status: "not_found" }
  | { status: "not_connected"; engine: AgentEngine }
  | { status: "provider_fixed"; engine: AgentEngine }
  | {
      status: "unsupported_selection";
      error: Exclude<ReturnType<typeof supportsSelection>, null>;
    };

export type ContinueSessionDeps = {
  /** The owner's undeleted Project, or null. */
  project(ownerId: string, projectId: string): Promise<ProjectRecord | null>;
  connected: AgentConnected;
  /** The execution settings of the Session's latest Turn, or null. */
  latestTurn(input: {
    ownerId: string;
    projectId: string;
    sessionId: string;
  }): Promise<string | null>;
  admitMessage(
    input: SessionMessage,
  ): Promise<{ runId: string } | "busy" | "not_found">;
};

/**
 * Sends the owner's message to a Session from its page. The next Turn keeps
 * the latest Turn's settings — its Model Provider, its mode, its Routine's
 * instructions and what started it — and only the model and effort may change.
 */
export async function continueSession(
  input: ContinueSessionInput,
  deps: ContinueSessionDeps,
): Promise<ContinueSessionResult> {
  for (let attempt = 0; ; attempt++) {
    const record = await deps.project(input.ownerId, input.projectId);
    if (!record) return { status: "not_found" };
    const latest = await deps.latestTurn(input);
    const previous = latest
      ? v.safeParse(ExecutionContext, JSON.parse(latest))
      : undefined;
    if (!previous?.success || previous.output.engine === "fake")
      return { status: "not_found" };
    const { engine } = previous.output;
    if (input.engine && input.engine !== engine)
      return { status: "provider_fixed", engine };
    const unsupported = supportsSelection(engine, input.model, input.effort);
    if (unsupported)
      return { status: "unsupported_selection", error: unsupported };
    if (!(await deps.connected(input.ownerId, engine)))
      return { status: "not_connected", engine };
    const { model: _model, effort: _effort, ...settings } = previous.output;
    const chosen = input.model || input.effort;
    const context = chosen
      ? {
          ...settings,
          ...(input.model && { model: input.model }),
          ...(input.effort && { effort: input.effort }),
        }
      : previous.output;
    try {
      const result = await deps.admitMessage({
        ownerId: input.ownerId,
        projectId: input.projectId,
        projectRevision: record.revision,
        sessionId: input.sessionId,
        requestId: input.requestId,
        body: input.message,
        executionContext: JSON.stringify(context),
        timeoutMs: record.project.maxRunMinutes * 60_000,
      });
      if (result === "busy" || result === "not_found")
        return { status: result };
      return { status: "started", runId: result.runId };
    } catch (error) {
      // Re-read the Project once when it changed between reading and saving.
      if (!(error instanceof ProjectChanged) || attempt > 0) throw error;
    }
  }
}

import type { ExecutionContext } from "@tailos/core/runner";
import { codexConnectionId } from "@/application/auth/device.ts";
import type { ProjectRecord } from "@/application/projects/store.ts";
import {
  ProjectChanged,
  type AdmitTrigger,
} from "@/application/triggers/admit-trigger.ts";

export type StartSessionInput = {
  ownerId: string;
  projectId: string;
  /** Issued by the client per message so a resend returns the first result. */
  requestId: string;
  message: string;
  model?: string;
  effort?: string;
  diagnostics?: { traceId: string; requestId: string };
};

export type StartSessionResult =
  | { status: "started"; sessionId: string; runId: string }
  | { status: "project_not_found" }
  | { status: "codex_not_connected" };

export type StartSessionDeps = {
  /** The owner's undeleted Project, or null. */
  project(ownerId: string, projectId: string): Promise<ProjectRecord | null>;
  codexConnected(ownerId: string): Promise<boolean>;
  defaultBranch(project: ProjectRecord["project"]): Promise<string>;
  admit: AdmitTrigger;
};

const maxTitleLength = 100;

/** The first non-empty line, without control characters, cut to the title limit. */
export function initialSessionTitle(message: string) {
  const line =
    message
      .split(/\r\n|[\n\r\u2028\u2029]/)
      .map((part) => part.replace(/\p{Cc}/gu, " ").trim())
      .find((part) => part.length > 0) ?? "";
  let title = "";
  for (const character of line) {
    if (title.length + character.length > maxTitleLength) break;
    title += character;
  }
  return title.trim() || undefined;
}

/** Starts a new Session and its first Run from a message sent on the home page. */
export async function startSessionFromMessage(
  input: StartSessionInput,
  deps: StartSessionDeps,
): Promise<StartSessionResult> {
  for (let attempt = 0; ; attempt++) {
    const record = await deps.project(input.ownerId, input.projectId);
    if (!record) return { status: "project_not_found" };
    if (!(await deps.codexConnected(input.ownerId)))
      return { status: "codex_not_connected" };
    const { project } = record;
    const executionContext: ExecutionContext = {
      version: 1,
      engine: "codex",
      connectionId: codexConnectionId(input.ownerId),
      ...(input.model && { model: input.model }),
      ...(input.effort && { effort: input.effort }),
      repository: {
        repository: project.repository,
        repositoryId: project.repositoryId,
        installationId: project.installationId,
        defaultBranch: await deps.defaultBranch(project),
      },
      trigger: { kind: "web.message" },
    };
    const title = initialSessionTitle(input.message);
    try {
      const admission = await deps.admit({
        source: "web.message",
        idempotencyKey: JSON.stringify([
          input.ownerId,
          project.id,
          input.requestId,
        ]),
        deliveryId: input.requestId,
        ownerId: input.ownerId,
        projectId: project.id,
        projectRevision: record.revision,
        target: JSON.stringify({
          version: 1,
          kind: "github.repository",
          repositoryId: project.repositoryId,
        }),
        ...(title && { initialTitle: title }),
        // Every message starts its own Session, so nothing is coalesced.
        concurrencyKey: JSON.stringify([
          "web.message",
          project.id,
          input.requestId,
        ]),
        authorKind: "user",
        prompt: input.message,
        executionContext: JSON.stringify(executionContext),
        timeoutMs: project.maxRunMinutes * 60_000,
        diagnostics: input.diagnostics,
      });
      return {
        status: "started",
        sessionId: admission.sessionId,
        runId: admission.runId,
      };
    } catch (error) {
      // Re-read the Project once when it changed between reading and saving.
      if (!(error instanceof ProjectChanged) || attempt > 0) throw error;
    }
  }
}

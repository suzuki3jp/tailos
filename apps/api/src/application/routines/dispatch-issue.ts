import {
  githubIssueDigest,
  type ExecutionContext,
  type RepositoryTarget,
  type RunTrigger,
} from "@tailos/core/runner";
import type { ProjectRecord } from "@/application/projects/store.ts";
import {
  ProjectChanged,
  type AdmitIssueMessage,
  type IssueMessage,
} from "@/application/triggers/admit-trigger.ts";
import { agentConnectionId } from "@/application/auth/agent-connection.ts";
import type {
  commentPayload,
  issueCommand,
  labelPayload,
} from "@/application/triggers/github-event.ts";
import type * as v from "valibot";
import type { Routine } from "./routines.ts";

export type IssueIgnoreReason =
  | "repository"
  | "installation"
  | "issue_state"
  | "pull_request"
  | "label"
  | "command"
  | "actor";
export type IssueResult = {
  routineId: string;
  sessionId: string;
  /** Absent while the message waits for the Session's current Turn. */
  runId?: string;
  disposition: "started" | "queued";
};
/** A reply telling the commenter how to start, sent once per comment. */
export type IssueGuidance = {
  id: string;
  target: RepositoryTarget;
  trigger: RunTrigger;
  body: string;
};
export const planningGuidance =
  "計画を開始するには、Issue の新しいコメントで @tailos plan を送ってください。";

type IssueEvent =
  | { kind: "label"; data: v.InferOutput<typeof labelPayload> }
  | {
      kind: "comment";
      data: v.InferOutput<typeof commentPayload>;
      command: NonNullable<ReturnType<typeof issueCommand>>;
    };

const allows = (routine: Routine, login: string) =>
  routine.allowedActors.some(
    (actor) => actor.toLowerCase() === login.toLowerCase(),
  );
const usable = (routine: Routine) => routine.enabled && !routine.deletedAt;

/**
 * Gives a message to every Routine an issue event reaches: a label to the
 * Routines for that label, `@tailos plan` to the plan Routines, and any other
 * `@tailos` comment to the issue's most recent comment Session.
 */
export async function dispatchIssueEvent(
  input: {
    event: IssueEvent;
    deliveryId: string;
    ownerId: string;
    diagnostics?: { traceId: string; requestId: string };
  },
  deps: {
    projects(): Promise<ProjectRecord[]>;
    routines(projectId: string): Promise<Routine[]>;
    replay(deliveryId: string, ownerId: string): Promise<IssueResult[]>;
    admit: AdmitIssueMessage;
    latestCommentSession(scope: {
      ownerId: string;
      projectId: string;
      repositoryId: number;
      issueNumber: number;
    }): Promise<string | null>;
    guide(guidance: IssueGuidance): Promise<void>;
    ignored?(reason: IssueIgnoreReason): void;
  },
) {
  const { event } = input;
  const data = event.data;
  const source: IssueMessage["source"] =
    event.kind === "label" ? "github.issue-label" : "github.issue-comment";
  const results = new Map(
    (await deps.replay(input.deliveryId, input.ownerId)).map((r) => [
      r.routineId,
      r,
    ]),
  );
  const started: string[] = [];
  let failed: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    failed = [];
    let conflict = false;
    for (const record of await deps.projects()) {
      const project = record.project;
      if (
        record.ownerId !== input.ownerId ||
        project.repositoryId !== data.repository.id ||
        project.repository.toLowerCase() !==
          data.repository.full_name.toLowerCase()
      )
        continue;
      if (project.installationId !== data.installation.id) {
        deps.ignored?.("installation");
        continue;
      }
      if (data.issue.state !== "open") {
        deps.ignored?.("issue_state");
        continue;
      }
      if (data.issue.pull_request) {
        deps.ignored?.("pull_request");
        continue;
      }
      deps.ignored?.(event.kind === "label" ? "label" : "command");
      const repository = {
        repository: project.repository,
        repositoryId: project.repositoryId,
        installationId: project.installationId,
        defaultBranch: data.repository.default_branch,
      };
      const issue = {
        issueNumber: data.issue.number,
        issueContentHash: await githubIssueDigest(data.issue),
      };
      const routines = await deps.routines(project.id);
      // Each Routine the event reaches, and whether it may start a Session.
      let reached: { routine: Routine; startsSession: boolean }[];
      if (event.kind === "label")
        reached = routines
          .filter(
            (routine) =>
              usable(routine) &&
              routine.trigger.type === "github.issue-label" &&
              routine.trigger.label === event.data.label.name,
          )
          .map((routine) => ({ routine, startsSession: true }));
      else if (event.command.command)
        reached = routines
          .filter(
            (routine) =>
              usable(routine) &&
              routine.trigger.type === "github.issue-comment" &&
              routine.trigger.command === event.command.command,
          )
          .map((routine) => ({ routine, startsSession: true }));
      else {
        const latest = await deps.latestCommentSession({
          ownerId: input.ownerId,
          projectId: project.id,
          repositoryId: project.repositoryId,
          issueNumber: data.issue.number,
        });
        const routine = routines.find((item) => item.id === latest);
        reached =
          routine && usable(routine) ? [{ routine, startsSession: false }] : [];
        if (!latest) {
          // Nothing to continue: say how to start, to someone who may.
          if (
            routines.some(
              (item) =>
                usable(item) &&
                item.trigger.type === "github.issue-comment" &&
                allows(item, data.sender.login),
            )
          )
            await deps.guide({
              id: `${project.repositoryId}/${event.data.comment.id}`,
              target: repository,
              trigger: { kind: "github.issue-comment", ...issue },
              body: planningGuidance,
            });
          continue;
        }
      }
      for (const { routine, startsSession } of reached) {
        if (results.has(routine.id)) continue;
        if (!allows(routine, data.sender.login)) {
          deps.ignored?.("actor");
          continue;
        }
        const trigger: RunTrigger =
          routine.trigger.type === "github.issue-label"
            ? {
                kind: "github.issue-label",
                ...issue,
                label: routine.trigger.label,
              }
            : { kind: "github.issue-comment", ...issue };
        const executionContext: ExecutionContext = {
          version: 1,
          engine: routine.engine,
          connectionId: agentConnectionId(routine.engine, input.ownerId),
          ...(routine.model && { model: routine.model }),
          ...(routine.effort && { effort: routine.effort }),
          routine: {
            id: routine.id,
            revision: routine.revision,
            projectRevision: record.revision,
          },
          // A comment is the user's message; the Routine says what to do
          // with it.
          ...(event.kind === "comment" && { instructions: routine.prompt }),
          repository,
          trigger,
        };
        try {
          const receipt = await deps.admit({
            source,
            idempotencyKey: JSON.stringify([
              project.id,
              routine.id,
              event.kind === "label" ? input.deliveryId : event.data.comment.id,
            ]),
            deliveryId: input.deliveryId,
            ownerId: input.ownerId,
            projectId: project.id,
            projectRevision: record.revision,
            routineId: routine.id,
            routineRevision: routine.revision,
            repositoryId: project.repositoryId,
            issueNumber: data.issue.number,
            startsSession,
            initialTitle: data.issue.title,
            triggerMetadata: JSON.stringify({
              kind: "github.issue",
              repository: project.repository,
              number: data.issue.number,
              url: `https://github.com/${project.repository}/issues/${data.issue.number}`,
            }),
            target: JSON.stringify({
              version: 1,
              kind: "github.issue",
              repositoryId: project.repositoryId,
              issueNumber: data.issue.number,
            }),
            body:
              event.kind === "label" ? routine.prompt : event.data.comment.body,
            executionContext: JSON.stringify(executionContext),
            timeoutMs: project.maxRunMinutes * 60_000,
            diagnostics: input.diagnostics,
          });
          if (!receipt) continue;
          if (receipt.started) started.push(receipt.started);
          results.set(routine.id, {
            routineId: routine.id,
            sessionId: receipt.sessionId,
            ...(receipt.runId && { runId: receipt.runId }),
            disposition: receipt.disposition,
          });
        } catch (error) {
          failed.push(routine.id);
          if (error instanceof ProjectChanged) conflict = true;
        }
      }
    }
    if (!conflict || attempt === 1) break;
  }
  return {
    results: [...results.values()].sort((a, b) =>
      a.routineId.localeCompare(b.routineId),
    ),
    failed,
    started,
  };
}

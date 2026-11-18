import { githubIssueDigest, type ExecutionContext } from "@tailos/core/runner";
import type { ProjectRecord } from "@/application/projects/store.ts";
import {
  ProjectChanged,
  type AdmitTrigger,
  type Admission,
} from "@/application/triggers/admit-trigger.ts";
import { codexConnectionId } from "@/application/auth/device.ts";
import type { labelPayload } from "@/application/triggers/github-event.ts";
import type * as v from "valibot";
import type { Routine } from "./routines.ts";
export type LabelIgnoreReason =
  | "repository"
  | "installation"
  | "issue_state"
  | "pull_request"
  | "label"
  | "actor";
export type LabelResult = Admission & { routineId: string };
export async function dispatchIssueLabel(
  input: {
    event: v.InferOutput<typeof labelPayload>;
    deliveryId: string;
    ownerId: string;
    diagnostics?: { traceId: string; requestId: string };
  },
  deps: {
    projects(): Promise<ProjectRecord[]>;
    routines(projectId: string): Promise<Routine[]>;
    replay(deliveryId: string, ownerId: string): Promise<LabelResult[]>;
    admit: AdmitTrigger;
    ignored?(reason: LabelIgnoreReason): void;
  },
) {
  const results = new Map(
    (await deps.replay(input.deliveryId, input.ownerId)).map((r) => [
      r.routineId,
      r,
    ]),
  );
  let failed: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    failed = [];
    let conflict = false;
    const { event } = input;
    const projects = await deps.projects();
    for (const record of projects) {
      const project = record.project;
      if (
        record.ownerId !== input.ownerId ||
        project.repositoryId !== event.repository.id ||
        project.repository.toLowerCase() !==
          event.repository.full_name.toLowerCase()
      )
        continue;
      if (project.installationId !== event.installation.id) {
        deps.ignored?.("installation");
        continue;
      }
      if (event.issue.state !== "open") {
        deps.ignored?.("issue_state");
        continue;
      }
      if (event.issue.pull_request) {
        deps.ignored?.("pull_request");
        continue;
      }
      deps.ignored?.("label");
      for (const routine of await deps.routines(project.id)) {
        if (
          results.has(routine.id) ||
          !routine.enabled ||
          routine.deletedAt !== null ||
          routine.trigger.label !== event.label.name
        )
          continue;
        if (
          !routine.allowedActors.some(
            (actor) => actor.toLowerCase() === event.sender.login.toLowerCase(),
          )
        ) {
          deps.ignored?.("actor");
          continue;
        }
        const executionContext: ExecutionContext = {
          version: 1,
          engine: "codex",
          connectionId: codexConnectionId(input.ownerId),
          ...(routine.model && { model: routine.model }),
          ...(routine.effort && { effort: routine.effort }),
          routine: {
            id: routine.id,
            revision: routine.revision,
            projectRevision: record.revision,
          },
          repository: {
            repository: project.repository,
            repositoryId: project.repositoryId,
            installationId: project.installationId,
            issueNumber: event.issue.number,
            issueContentHash: await githubIssueDigest(event.issue),
            defaultBranch: event.repository.default_branch,
            triggerLabel: routine.trigger.label,
            agentNetworkAccess: project.agentNetworkAccess,
          },
        };
        try {
          const admission = await deps.admit({
            source: "github.issue-label",
            idempotencyKey: JSON.stringify([
              project.id,
              routine.id,
              input.deliveryId,
            ]),
            deliveryId: input.deliveryId,
            routineId: routine.id,
            routineRevision: routine.revision,
            ownerId: input.ownerId,
            projectId: project.id,
            projectRevision: record.revision,
            initialTitle: event.issue.title,
            triggerMetadata: JSON.stringify({
              kind: "github.issue",
              repository: project.repository,
              number: event.issue.number,
              url: `https://github.com/${project.repository}/issues/${event.issue.number}`,
            }),
            target: JSON.stringify({
              version: 1,
              kind: "github.issue",
              repositoryId: project.repositoryId,
              issueNumber: event.issue.number,
            }),
            concurrencyKey: JSON.stringify([
              "github.issue-label",
              project.id,
              routine.id,
              project.repositoryId,
              event.issue.number,
            ]),
            prompt: routine.prompt,
            executionContext: JSON.stringify(executionContext),
            timeoutMs: project.maxRunMinutes * 60_000,
            diagnostics: input.diagnostics,
          });
          results.set(routine.id, { ...admission, routineId: routine.id });
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
  };
}

import {
  dispatchIssueLabel,
  type LabelResult,
} from "@/application/routines/dispatch-label.ts";
import type { Routine } from "@/application/routines/routines.ts";
import type { AdmitTrigger } from "@/application/triggers/admit-trigger.ts";
import { ProjectChanged } from "@/application/triggers/admit-trigger.ts";
import type { ProjectRecord } from "@/application/projects/store.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { parseGithubEvent } from "@/application/triggers/github-event.ts";
import type {
  PlanningAdmission,
  PlanningReceipt,
} from "@/application/triggers/planning.ts";
import { type ExecutionContext } from "@tailos/core/runner";
import { codexConnectionId } from "@/application/auth/device.ts";
import type { Bindings } from "@/bindings.ts";
import type { TriggerDiagnostic } from "@/application/diagnostics/store.ts";

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function createGithubWebhook(
  scheduleRun: (env: Bindings) => ((id: string) => Promise<void>) | undefined,
  admit: (env: Bindings) => AdmitTrigger,
  findOperatorUserId: (env: Bindings) => Promise<string | null>,
  validSignature: (
    secret: string,
    header: string | undefined,
    body: ArrayBuffer,
  ) => Promise<boolean>,
  readProjects: (env: Bindings) => Promise<ProjectRecord[]>,
  recordDecision: (
    env: Bindings,
    event: TriggerDiagnostic,
  ) => Promise<void> = async () => {},
  notify: (env: Bindings) => Promise<void> = async () => {},
  acceptPlan?: (
    env: Bindings,
    input: PlanningAdmission,
  ) => Promise<PlanningReceipt>,
  processPlans: (env: Bindings) => Promise<void> = async () => {},
  readRoutines: (
    env: Bindings,
    projectId: string,
  ) => Promise<Routine[]> = async () => [],
  replayLabels: (
    env: Bindings,
    deliveryId: string,
    ownerId: string,
  ) => Promise<LabelResult[]> = async () => [],
) {
  const githubWebhook = new Hono<{ Bindings: Bindings }>();
  githubWebhook.post("/", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const secret = c.env?.TAILOS_GH_WEBHOOK_SECRET;
    if (!secret || !c.env.TAILOS_GH_APP_ID || !c.env.TAILOS_GH_APP_PRIVATE_KEY)
      return c.notFound();

    const bytes = await c.req.arrayBuffer();
    if (
      !(await validSignature(
        secret,
        c.req.header("X-Hub-Signature-256"),
        bytes,
      ))
    )
      return c.json({ error: "invalid_signature" }, 401);
    const decision = async (
      reason: TriggerDiagnostic["reason"],
      outcome: TriggerDiagnostic["outcome"] = "ignored",
      routineId?: string,
    ) => {
      const delivery = c.req.header("X-GitHub-Delivery");
      await recordDecision(c.env, {
        ...c.get("diagnosticRequest"),
        source:
          c.req.header("X-GitHub-Event") === "issue_comment"
            ? "github.issue-plan"
            : "github.issue-label",
        reason,
        outcome,
        ...(routineId && { routineId }),
        ...(delivery && /^[A-Za-z0-9-]{1,100}$/.test(delivery)
          ? { deliveryId: delivery }
          : {}),
      }).catch(() => {
        // oxlint-disable-next-line no-console -- IDs and allowlisted enums only; detail must not change the webhook result.
        console.warn("Trigger diagnostic write failed", {
          ...c.get("diagnosticRequest"),
          reason,
          outcome,
        });
      });
    };
    const ignore = async (reason: TriggerDiagnostic["reason"]) => {
      await decision(reason);
      return c.body(null, 204);
    };
    const normalized = parseGithubEvent(
      c.req.header("X-GitHub-Event"),
      parseJson(new TextDecoder().decode(bytes)),
    );
    if (normalized.kind === "ignored") return ignore(normalized.reason);
    if (normalized.kind === "invalid") {
      await decision("invalid_event", "failed");
      return c.json({ error: "invalid_event" }, 400);
    }

    if (normalized.kind === "label") {
      const delivery = c.req.header("X-GitHub-Delivery");
      if (!delivery || !/^[A-Za-z0-9-]{1,100}$/.test(delivery)) {
        await decision("delivery", "failed");
        return c.json({ error: "missing_delivery_id" }, 400);
      }
      const ownerId = await findOperatorUserId(c.env);
      if (!ownerId) return c.json({ error: "operator_not_initialized" }, 503);
      let result;
      try {
        result = await dispatchIssueLabel(
          {
            event: normalized.data,
            deliveryId: delivery,
            ownerId,
            diagnostics: c.get("diagnosticRequest"),
          },
          {
            projects: () => readProjects(c.env),
            routines: (id) => readRoutines(c.env, id),
            replay: (id, owner) => replayLabels(c.env, id, owner),
            admit: admit(c.env),
          },
        );
      } catch {
        await decision("project_config", "failed");
        return c.json({ error: "invalid_project_config" }, 503);
      }
      for (const admission of result.results) {
        await scheduleRun(c.env)?.(admission.runId).catch(async () => {
          await decision("schedule", "unknown");
        });
      }
      if (result.results.length) c.executionCtx.waitUntil(notify(c.env));
      if (result.failed.length) {
        for (const routineId of result.failed)
          await decision("project_config", "failed", routineId);
        return c.json({ ...result, error: "routine_admission_failed" }, 503);
      }
      if (!result.results.length) return ignore("label");
      return c.json(result, 202);
    }

    // Repeat only admission-time Project conflicts. Every retry rereads and
    // reauthorizes the entire trigger; signatures and event parsing stay fixed.
    const accept = async () => {
      let projects: ProjectRecord[];
      try {
        projects = await readProjects(c.env);
      } catch {
        await decision("project_config", "failed");
        return c.json({ error: "invalid_project_config" }, 503);
      }
      const data = normalized.data;
      const projectRecord = projects.find(
        (item) => item.project.repositoryId === data.repository.id,
      );
      const target = projectRecord?.project;
      if (
        !target ||
        target.repository.toLowerCase() !==
          data.repository.full_name.toLowerCase()
      )
        return ignore("repository");
      if (target.installationId !== data.installation.id)
        return ignore("installation");
      if (
        !target.allowedActors.some(
          (actor) => actor.toLowerCase() === data.sender.login.toLowerCase(),
        )
      )
        return ignore("actor");
      if (data.issue.state !== "open") return ignore("issue_state");
      if (data.issue.pull_request) return ignore("pull_request");

      const delivery = c.req.header("X-GitHub-Delivery");
      if (!delivery || !/^[A-Za-z0-9-]{1,100}$/.test(delivery)) {
        await decision("delivery", "failed");
        return c.json({ error: "missing_delivery_id" }, 400);
      }

      const ownerId = await findOperatorUserId(c.env);
      if (!ownerId) {
        await decision("operator", "failed");
        return c.json({ error: "operator_not_initialized" }, 503);
      }

      const executionContext = {
        version: 1,
        engine: "codex",
        connectionId: codexConnectionId(ownerId),
        repository: {
          repository: target.repository,
          repositoryId: target.repositoryId,
          installationId: target.installationId,
          issueNumber: data.issue.number,
          defaultBranch: data.repository.default_branch,
          agentNetworkAccess: target.agentNetworkAccess,
        },
      } satisfies ExecutionContext;
      const sessionMetadata = {
        initialTitle: data.issue.title,
        triggerMetadata: JSON.stringify({
          kind: "github.issue",
          repository: target.repository,
          number: data.issue.number,
          url: `https://github.com/${target.repository}/issues/${data.issue.number}`,
        }),
      };
      if ("comment" in data && normalized.kind === "comment") {
        if (!acceptPlan) return c.json({ error: "planning_unavailable" }, 503);
        const receipt = await acceptPlan(c.env, {
          ...sessionMetadata,
          ownerId,
          projectId: target.id,
          projectRevision: projectRecord?.revision,
          repositoryId: target.repositoryId,
          issueNumber: data.issue.number,
          commentId: data.comment.id,
          actor: data.comment.user.login,
          url: data.comment.html_url,
          body: data.comment.body,
          deliveryId: delivery,
          start: normalized.command.start,
          executionContext: JSON.stringify({
            ...executionContext,
            mode: "plan",
          }),
          timeoutMs: target.maxRunMinutes * 60_000,
        });
        c.executionCtx.waitUntil(
          processPlans(c.env)
            .catch(async () => {
              // The recovery sweep can dispatch and schedule the persisted input.
              await decision("schedule", "unknown");
            })
            .then(() => notify(c.env)),
        );
        return c.json(receipt, 202);
      }
      return c.json({ error: "invalid_event" }, 400);
    };
    try {
      return await accept();
    } catch (error) {
      if (!(error instanceof ProjectChanged)) throw error;
    }
    try {
      return await accept();
    } catch (error) {
      if (!(error instanceof ProjectChanged)) throw error;
      await decision("project_config", "failed");
      return c.json({ error: "project_changed" }, 503);
    }
  });

  return githubWebhook;
}

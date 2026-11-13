import type { AdmitTrigger } from "@/application/triggers/admit-trigger.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { parseGithubEvent } from "@/application/triggers/github-event.ts";
import type {
  PlanningAdmission,
  PlanningReceipt,
} from "@/application/triggers/planning.ts";
import type { ExecutionContext } from "@tailos/core/runner";
import { codexConnectionId } from "@/application/auth/device.ts";
import type { Bindings } from "@/bindings.ts";
import { projectsSchema } from "@/application/triggers/projects.ts";
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
) {
  const githubWebhook = new Hono<{ Bindings: Bindings }>();
  githubWebhook.post("/", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const secret = c.env?.TAILOS_GH_WEBHOOK_SECRET;
    if (
      !secret ||
      !c.env.PROJECTS ||
      !c.env.TAILOS_GH_APP_ID ||
      !c.env.TAILOS_GH_APP_PRIVATE_KEY
    )
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

    const config = v.safeParse(projectsSchema, parseJson(c.env.PROJECTS));
    if (!config.success) {
      await decision("project_config", "failed");
      return c.json({ error: "invalid_project_config" }, 503);
    }
    const data = normalized.data;
    const target = config.output.find(
      (item) => item.repositoryId === data.repository.id,
    );
    if (
      !target ||
      target.repository.toLowerCase() !==
        data.repository.full_name.toLowerCase()
    )
      return ignore("repository");
    if (target.installationId !== data.installation.id)
      return ignore("installation");
    if ("label" in data && target.triggerLabel !== data.label.name)
      return ignore("label");
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
        triggerLabel: target.triggerLabel,
        agentNetworkAccess: target.agentNetworkAccess,
      },
    } satisfies ExecutionContext;
    if ("comment" in data && normalized.kind === "comment") {
      if (!acceptPlan) return c.json({ error: "planning_unavailable" }, 503);
      const receipt = await acceptPlan(c.env, {
        ownerId,
        projectId: target.id,
        repositoryId: target.repositoryId,
        issueNumber: data.issue.number,
        commentId: data.comment.id,
        actor: data.comment.user.login,
        url: data.comment.html_url,
        body: data.comment.body,
        deliveryId: delivery,
        start: normalized.command.start,
        executionContext: JSON.stringify({ ...executionContext, mode: "plan" }),
        timeoutMs: target.maxRunMinutes * 60_000,
      });
      c.executionCtx.waitUntil(
        processPlans(c.env).catch(async () => {
          // The recovery sweep can dispatch and schedule the persisted input.
          await decision("schedule", "unknown");
        }),
      );
      c.executionCtx.waitUntil(notify(c.env));
      return c.json(receipt, 202);
    }
    const prompt = [
      `Implement GitHub issue #${data.issue.number} in ${target.repository}.`,
      "Make the required changes, run relevant checks, and summarize the result. Tailos handles publishing.",
      "",
      data.issue.title.slice(0, 240),
      (data.issue.body ?? "").slice(0, 3200),
    ].join("\n");

    const result = await admit(c.env)({
      source: "github.issue-label",
      idempotencyKey: delivery,
      ownerId,
      projectId: target.id,
      target: JSON.stringify({
        version: 1,
        kind: "github.issue",
        repositoryId: target.repositoryId,
        issueNumber: data.issue.number,
      }),
      concurrencyKey: JSON.stringify([
        "github.issue-label",
        target.repositoryId,
        data.issue.number,
      ]),
      prompt,
      executionContext: JSON.stringify(executionContext),
      timeoutMs: target.maxRunMinutes * 60_000,
      diagnostics: c.get("diagnosticRequest"),
    });
    c.executionCtx.waitUntil(notify(c.env));
    await scheduleRun(c.env)?.(result.runId).catch(async () => {
      // The recovery sweep can schedule the committed run.
      await decision("schedule", "unknown");
    });
    return c.json(result, 202);
  });

  return githubWebhook;
}

import {
  dispatchIssueEvent,
  type IssueGuidance,
  type IssueIgnoreReason,
  type IssueResult,
} from "@/application/routines/dispatch-issue.ts";
import type { Routine } from "@/application/routines/routines.ts";
import type {
  AdmitIssueMessage,
  IssueMessage,
} from "@/application/triggers/admit-trigger.ts";
import type { ProjectRecord } from "@/application/projects/store.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { parseGithubEvent } from "@/application/triggers/github-event.ts";
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
  admit: (env: Bindings) => AdmitIssueMessage,
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
  readRoutines: (
    env: Bindings,
    projectId: string,
  ) => Promise<Routine[]> = async () => [],
  replay: (
    env: Bindings,
    source: IssueMessage["source"],
    deliveryId: string,
    ownerId: string,
    diagnostics?: { traceId: string; requestId: string },
  ) => Promise<IssueResult[]> = async () => [],
  latestCommentSession: (
    env: Bindings,
    scope: {
      ownerId: string;
      projectId: string;
      repositoryId: number;
      issueNumber: number;
    },
  ) => Promise<string | null> = async () => null,
  guide: (
    env: Bindings,
    guidance: IssueGuidance,
  ) => Promise<void> = async () => {},
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
            ? "github.issue-comment"
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
    const source: IssueMessage["source"] =
      normalized.kind === "label"
        ? "github.issue-label"
        : "github.issue-comment";
    let result;
    let ignoredReason: IssueIgnoreReason = "repository";
    let guided = false;
    try {
      result = await dispatchIssueEvent(
        {
          event: normalized,
          deliveryId: delivery,
          ownerId,
          diagnostics: c.get("diagnosticRequest"),
        },
        {
          projects: () => readProjects(c.env),
          routines: (id) => readRoutines(c.env, id),
          replay: (id, owner) =>
            replay(c.env, source, id, owner, c.get("diagnosticRequest")),
          admit: admit(c.env),
          latestCommentSession: (scope) => latestCommentSession(c.env, scope),
          guide: async (guidance) => {
            await guide(c.env, guidance);
            guided = true;
          },
          ignored: (reason) => {
            ignoredReason = reason;
          },
        },
      );
    } catch {
      await decision("project_config", "failed");
      return c.json({ error: "invalid_project_config" }, 503);
    }
    // GitHub gets its answer without waiting: the Turns and the issue
    // comments are already saved.
    const started = result.started;
    if (started.length || guided)
      c.executionCtx.waitUntil(
        Promise.all(
          started.map((runId) =>
            scheduleRun(c.env)?.(runId).catch(async () => {
              // The recovery sweep schedules the persisted Turn.
              await decision("schedule", "unknown");
            }),
          ),
        ).then(() => notify(c.env)),
      );
    const body = { results: result.results, failed: result.failed };
    if (result.failed.length) {
      for (const routineId of result.failed)
        await decision("project_config", "failed", routineId);
      return c.json({ ...body, error: "routine_admission_failed" }, 503);
    }
    if (!result.results.length) {
      if (guided) return c.json(body, 202);
      return ignore(ignoredReason);
    }
    return c.json(body, 202);
  });

  return githubWebhook;
}

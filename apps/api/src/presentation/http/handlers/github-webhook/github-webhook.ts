import type { AdmitTrigger } from "@/application/triggers/admit-trigger.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import type { ExecutionContext } from "@tailos/core/runner";
import { codexConnectionId } from "@/application/auth/device.ts";
import type { Bindings } from "@/bindings.ts";
import { projectsSchema } from "@/application/triggers/projects.ts";

const id = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const repository = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);
const payload = v.object({
  repository: v.object({
    id,
    full_name: repository,
    default_branch: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  }),
  installation: v.object({ id }),
  issue: v.object({
    number: id,
    title: v.string(),
    body: v.nullable(v.string()),
    state: v.string(),
    pull_request: v.optional(v.unknown()),
  }),
  label: v.object({ name: v.string() }),
  sender: v.object({ login: v.string() }),
});

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
    if (c.req.header("X-GitHub-Event") !== "issues") return c.body(null, 204);

    const event = parseJson(new TextDecoder().decode(bytes));
    if (!event || typeof event !== "object" || !("action" in event))
      return c.json({ error: "invalid_event" }, 400);
    if (event.action !== "labeled") return c.body(null, 204);
    const issueEvent = v.safeParse(payload, event);
    if (!issueEvent.success) return c.json({ error: "invalid_event" }, 400);

    const config = v.safeParse(projectsSchema, parseJson(c.env.PROJECTS));
    if (!config.success)
      return c.json({ error: "invalid_project_config" }, 503);
    const data = issueEvent.output;
    const target = config.output.find(
      (item) => item.repositoryId === data.repository.id,
    );
    if (
      !target ||
      target.repository.toLowerCase() !==
        data.repository.full_name.toLowerCase() ||
      target.installationId !== data.installation.id ||
      target.triggerLabel !== data.label.name ||
      !target.allowedActors.some(
        (actor) => actor.toLowerCase() === data.sender.login.toLowerCase(),
      ) ||
      data.issue.state !== "open" ||
      data.issue.pull_request
    )
      return c.body(null, 204);

    const delivery = c.req.header("X-GitHub-Delivery");
    if (!delivery || !/^[A-Za-z0-9-]{1,100}$/.test(delivery))
      return c.json({ error: "missing_delivery_id" }, 400);

    const ownerId = await findOperatorUserId(c.env);
    if (!ownerId) return c.json({ error: "operator_not_initialized" }, 503);

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
      },
    } satisfies ExecutionContext;
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
    });
    await scheduleRun(c.env)?.(result.runId).catch(() => {
      // The recovery sweep can schedule the committed run.
    });
    return c.json(result, 202);
  });

  return githubWebhook;
}

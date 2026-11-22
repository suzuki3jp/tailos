import {
  d1Routines,
  replayLabelDelivery,
} from "@/infrastructure/d1/routines.ts";
import { implementationPrompt } from "@/application/routines/routines.ts";
import { Hono } from "hono";
import { expect, test, vi, type TestContext } from "vitest";
import { createGithubWebhook } from "./github-webhook.ts";
import { ProjectChanged } from "@/application/triggers/admit-trigger.ts";
import { requestDiagnostics } from "@/presentation/http/middlewares/request-diagnostics.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { acceptPlanningInput } from "@/infrastructure/d1/planning.ts";
import type { Bindings } from "@/bindings.ts";

const settings = {
  name: "Tailos",
  repository: "owner/repo",
  repositoryId: 42,
  installationId: 19,
  allowedActors: ["allowed"],
  maxRunMinutes: 30,
};
type Kind = "label" | "comment";
type Change =
  | "settings"
  | "actor"
  | "installation"
  | "repository"
  | "deleted"
  | "label"
  | "repeated"
  | "unexpected";
async function fixture(t: TestContext, kind: Kind, change: Change) {
  const DB = await createTestDb(t);
  const store = d1Projects(DB);
  const owner = "00000000-0000-4000-8000-000000000001";
  const project = await store.create(settings, owner);
  const routines = d1Routines(DB);
  const routine = await routines.save(owner, project.project.id, {
    name: "Implementation",
    enabled: true,
    trigger: { version: 1, type: "github.issue-label", label: "tailos:run" },
    allowedActors: settings.allowedActors,
    engine: "codex",
    prompt: implementationPrompt,
  });
  let attempts = 0;
  const race = async () => {
    attempts++;
    if (change === "unexpected") throw new Error("original owner mismatch");
    if (change === "repeated") throw new ProjectChanged("another edit");
    if (attempts !== 1) return;
    if (kind === "label" && (change === "actor" || change === "label")) {
      await routines.save(
        owner,
        project.project.id,
        {
          name: routine!.name,
          enabled: routine!.enabled,
          trigger: routine!.trigger,
          allowedActors: routine!.allowedActors,
          prompt: routine!.prompt,
          engine: routine!.engine,
          ...(change === "actor"
            ? { allowedActors: ["someone-else"] }
            : { trigger: { ...routine!.trigger, label: "new-label" } }),
        },
        { id: routine!.id, revision: 1 },
      );
    }
    if (change === "deleted") {
      await store.remove(project.project.id, 1, owner);
      return;
    }
    await store.update(
      project.project.id,
      1,
      {
        ...settings,
        maxRunMinutes: 2,
        ...(change === "actor" && { allowedActors: ["someone-else"] }),
        ...(change === "installation" && { installationId: 20 }),
        ...(change === "repository" && { repositoryId: 43 }),
      },
      owner,
    );
  };
  const read = vi.fn(() => store.list());
  const diagnostic = vi.fn(async () => {});
  const routes = createGithubWebhook(
    () => undefined,
    (env) => async (input) => {
      await race();
      return admitTrigger(env.DB, input);
    },
    async () => "00000000-0000-4000-8000-000000000001",
    async () => true,
    read,
    diagnostic,
    async () => {},
    async (env, input) => {
      await race();
      return acceptPlanningInput(env.DB, input);
    },
    async () => {},
    (env, id) => d1Routines(env.DB).candidates(id),
    (env, id, ownerId) => replayLabelDelivery(env.DB, id, ownerId),
  );
  const app = new Hono<{ Bindings: Bindings }>()
    .use("*", requestDiagnostics)
    .route("/webhooks/github", routes)
    .onError((_error, c) => c.json({ error: "unexpected" }, 500));
  const event = {
    action: kind === "label" ? "labeled" : "created",
    repository: { id: 42, full_name: "owner/repo", default_branch: "main" },
    installation: { id: 19 },
    issue: { number: 3, title: "Issue", body: "Details", state: "open" },
    sender: { login: "allowed", type: "User" },
    ...(kind === "label"
      ? { label: { name: "tailos:run" } }
      : {
          comment: {
            id: 100,
            user: { login: "allowed", type: "User" },
            body: "@tailos plan",
            html_url: "https://github.com/owner/repo/issues/3#issuecomment-100",
          },
        }),
  };
  const send = () =>
    app.request(
      "https://api.tailos.example/webhooks/github",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": kind === "label" ? "issues" : "issue_comment",
          "X-GitHub-Delivery": "delivery",
        },
        body: JSON.stringify(event),
      },
      {
        DB,
        TAILOS_GH_WEBHOOK_SECRET: "test",
        TAILOS_GH_APP_ID: "100",
        TAILOS_GH_APP_PRIVATE_KEY: "unused",
      },
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} },
    );
  return { DB, read, diagnostic, send, attempts: () => attempts };
}

test.for(["label", "comment"] as const)(
  "retries %s admission once with refreshed settings and no duplicate conversation",
  async (kind, t) => {
    const f = await fixture(t, kind, "settings");
    expect((await f.send()).status).toBe(202);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.attempts()).toBe(2);
    expect(
      await f.DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
    ).toBe(1);
    if (kind === "label") {
      const row = await f.DB.prepare(
        "SELECT execution_context, deadline_at - created_at AS timeout FROM runs",
      ).first<{ execution_context: string; timeout: number }>();
      expect(JSON.parse(row!.execution_context).repository).not.toHaveProperty(
        "agentNetworkAccess",
      );
      expect(row!.timeout).toBe(120_000);
    } else {
      const row = await f.DB.prepare(
        "SELECT execution_context, timeout_ms AS timeout FROM planning_inbox",
      ).first<{ execution_context: string; timeout: number }>();
      expect(JSON.parse(row!.execution_context).repository).not.toHaveProperty(
        "agentNetworkAccess",
      );
      expect(row!.timeout).toBe(120_000);
    }
  },
);

for (const kind of ["label", "comment"] as const) {
  test.for(["actor", "installation", "repository", "deleted"] as const)(
    `reauthorizes ${kind} after a concurrent %s change`,
    async (change, t) => {
      const f = await fixture(t, kind, change);
      expect((await f.send()).status).toBe(204);
      expect(f.read).toHaveBeenCalledTimes(2);
      expect(f.attempts()).toBe(1);
      expect(
        await f.DB.prepare("SELECT count(*) AS n FROM sessions").first("n"),
      ).toBe(0);
    },
  );
  test(`limits ${kind} conflict retry to two total attempts and records the final failure`, async (t) => {
    const f = await fixture(t, kind, "repeated");
    const response = await f.send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: kind === "label" ? "routine_admission_failed" : "project_changed",
    });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.attempts()).toBe(2);
    expect(f.diagnostic).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ reason: "project_config", outcome: "failed" }),
    );
  });
  test(`does not retry ${kind} storage failures or unrelated admission errors`, async (t) => {
    const storage = await fixture(t, kind, "settings");
    storage.read.mockRejectedValueOnce(new Error("D1 unavailable"));
    expect((await storage.send()).status).toBe(503);
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(storage.attempts()).toBe(0);
    const mismatch = await fixture(t, kind, "unexpected");
    expect((await mismatch.send()).status).toBe(kind === "label" ? 503 : 500);
    expect(mismatch.attempts()).toBe(1);
    expect(mismatch.read).toHaveBeenCalledTimes(1);
  });
}

test("rechecks the implementation trigger label on retry", async (t) => {
  const f = await fixture(t, "label", "label");
  expect((await f.send()).status).toBe(204);
  expect(f.attempts()).toBe(1);
});

import {
  d1Routines,
  replayLabelDelivery,
} from "@/infrastructure/d1/routines.ts";
import { createRoutineRoutes } from "@/presentation/http/handlers/routines/routines.ts";
import { codexConnectionId } from "@/application/auth/device.ts";
import { acceptPlanningInput } from "@/infrastructure/d1/planning.ts";
import { processPlanningInputs } from "@/bootstrap/planning.ts";
import { deliverIssueNotifications } from "@/bootstrap/issue-notifications.ts";
import { validSignature } from "@/infrastructure/github/webhook-signature.ts";
import { createOperatorAuth } from "@/presentation/http/middlewares/operator.ts";
import {
  createLoginAuth,
  findOperatorUserId,
  getOperatorSession,
} from "@/infrastructure/auth/login.ts";
import { findActiveRun } from "@/infrastructure/d1/active-run.ts";
import { findOwnedRun } from "@/infrastructure/d1/owned-runs.ts";
import { readRunArtifact } from "@/infrastructure/r2/run-artifacts.ts";
import { checkRunnerHealth } from "@/infrastructure/cloudflare/runner-health.ts";
import { runStarter } from "@/infrastructure/cloudflare/run-start.ts";
import { createRunnerHealthRoutes } from "@/presentation/http/handlers/runner-health/runner-health.ts";
import { admitTrigger } from "@/infrastructure/d1/trigger-admission.ts";
import { Hono } from "hono";
import type { ApplyGlobalResponse } from "hono/client";
import { cors } from "hono/cors";
import { createGithubWebhook } from "@/presentation/http/handlers/github-webhook/github-webhook.ts";
import { createConnectRoutes } from "@/presentation/http/handlers/connect/connect.ts";
import { createLoginRoutes } from "@/presentation/http/handlers/login/login.ts";
import { createRefreshRoutes } from "@/presentation/http/handlers/refresh/refresh.ts";
import { type Bindings } from "@/bindings.ts";
import { createRunRoutes } from "@/presentation/http/handlers/runs/runs.ts";
import { createSessionRoutes } from "@/presentation/http/handlers/sessions/sessions.ts";
import { d1Sessions } from "@/infrastructure/d1/sessions.ts";
import { createTriggerRoutes } from "@/presentation/http/handlers/triggers/triggers.ts";
import { requestDiagnostics } from "@/presentation/http/middlewares/request-diagnostics.ts";
import {
  diagnosticReader,
  canIngestDiagnostics,
  recordTriggerDecision,
} from "@/infrastructure/diagnostics/store.ts";
import { createDiagnosticRoutes } from "@/presentation/http/handlers/diagnostics/diagnostics.ts";
import { createDiagnosticIngestRoutes } from "@/presentation/http/handlers/diagnostics/ingest.ts";

import { authenticateMcpKey } from "@/infrastructure/auth/mcp-key.ts";
import { inspectionStore } from "@/infrastructure/inspection.ts";
import { createMcpRoutes } from "@/presentation/http/handlers/mcp/mcp.ts";
import { createMcpKeyRoutes } from "@/presentation/http/handlers/mcp-keys/mcp-keys.ts";
import { d1McpKeys } from "@/infrastructure/d1/mcp-keys.ts";
import { d1Projects } from "@/infrastructure/d1/projects.ts";
import { GitHubApp } from "@/infrastructure/github/app.ts";
import { createProjectRoutes } from "@/presentation/http/handlers/projects/projects.ts";

const operatorAuth = createOperatorAuth(getOperatorSession);

const { sessionRoutes, userSessionRoutes } = createSessionRoutes(
  (env) => d1Sessions(env.DB),
  operatorAuth,
);

const triggerRoutes = createTriggerRoutes(
  (env) => runStarter(env.RUNNER),
  (env) => (input) => admitTrigger(env.DB, input),
  findOperatorUserId,
);

const githubWebhook = createGithubWebhook(
  (env) => runStarter(env.RUNNER),
  (env) => (input) => admitTrigger(env.DB, input),
  findOperatorUserId,
  validSignature,
  (env) => d1Projects(env.DB).list(),
  (env, event) => recordTriggerDecision(env.DB, event),
  deliverIssueNotifications,
  (env, input) => acceptPlanningInput(env.DB, input),
  processPlanningInputs,
  (env, id) => d1Routines(env.DB).candidates(id),
  (env, delivery, owner) => replayLabelDelivery(env.DB, delivery, owner),
);

const runRoutes = createRunRoutes(
  (env) => runStarter(env.RUNNER),
  (env, id, ownerId) => findOwnedRun(env.DB, id, ownerId),
  (env, id, file, result) =>
    env.RUN_ARTIFACTS
      ? readRunArtifact(env.RUN_ARTIFACTS, id, file, result)
      : Promise.resolve(null),
);

const refreshRoutes = createRefreshRoutes((env, runId, now) =>
  findActiveRun(env.DB, runId, now),
);

const loginRoutes = createLoginRoutes(createLoginAuth);

const connectRoutes = createConnectRoutes(operatorAuth);

const runnerHealth = createRunnerHealthRoutes((env) =>
  checkRunnerHealth(env.RUNNER),
);

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", requestDiagnostics);

const browserApi = new Hono<{ Bindings: Bindings }>()
  .use(
    "*",
    cors({
      origin: (origin, c) =>
        origin === c.env?.TAILOS_WEB_ORIGIN ? origin : undefined,
      credentials: true,
      allowMethods: ["GET", "POST"],
      exposeHeaders: ["X-Request-ID"],
    }),
  )
  .get("/account", operatorAuth, (c) =>
    c.json({
      connectEnabled: Boolean(
        c.env.CREDENTIALS && c.env.CREDENTIAL_ENCRYPTION_KEY,
      ),
    }),
  )
  .route("/connect", connectRoutes)
  .route(
    "/projects",
    createProjectRoutes(
      (env) => d1Projects(env.DB),
      (env) => {
        if (!env.TAILOS_GH_APP_ID || !env.TAILOS_GH_APP_PRIVATE_KEY)
          throw new Error("GitHub App is not configured");
        return new GitHubApp({
          appId: env.TAILOS_GH_APP_ID,
          privateKey: env.TAILOS_GH_APP_PRIVATE_KEY,
        }).projectRepositories();
      },
      operatorAuth,
    ),
  )
  .route(
    "/projects/:projectId/routines",
    createRoutineRoutes(
      (env) => d1Routines(env.DB),
      (env) => async (ownerId) =>
        env.CREDENTIALS && env.CREDENTIAL_ENCRYPTION_KEY
          ? (env.CREDENTIALS.getByName(
              codexConnectionId(ownerId),
            ).codexModels?.() ?? null)
          : null,
      operatorAuth,
    ),
  )
  .route("/sessions", userSessionRoutes)
  .route(
    "/mcp-keys",
    createMcpKeyRoutes((env) => d1McpKeys(env.DB), operatorAuth),
  )
  .route(
    "/diagnostics",
    createDiagnosticRoutes(
      (env) => diagnosticReader(env.DB, env.RUN_ARTIFACTS),
      operatorAuth,
    ),
  );

export type BrowserApi = ApplyGlobalResponse<
  typeof browserApi,
  {
    401: { json: { error: "unauthorized" } };
    403: { json: { error: "forbidden" } };
    404: { json: { error: "not_found" } };
  }
>;

app.route("/v1", browserApi);
app.route("/v1/auth", loginRoutes);
app.route("/mcp", createMcpRoutes(authenticateMcpKey, inspectionStore));
app.route("/webhooks/github", githubWebhook);
app.route("/_runner/runs", refreshRoutes);
app.route(
  "/_runner/runs",
  createDiagnosticIngestRoutes((env, id, now) =>
    canIngestDiagnostics(env.DB, id, now),
  ),
);
app.get("/health", (c) => c.json({ status: "ok", service: "tailos-api" }));
app.route("/_internal/runs", runRoutes);
app.route("/_internal/sessions", sessionRoutes);
app.route("/_internal/triggers", triggerRoutes);

app.route("/_internal/runner", runnerHealth);

export default app;

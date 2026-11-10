import { validSignature } from "../infrastructure/github/webhook-signature.ts";
import { createOperatorAuth } from "../presentation/http/operator.ts";
import {
  createLoginAuth,
  findOperatorUserId,
  getOperatorSession,
} from "../infrastructure/auth/login.ts";
import { findActiveRun } from "../infrastructure/d1/active-run.ts";
import { findOwnedRun } from "../infrastructure/d1/owned-runs.ts";
import { readRunArtifact } from "../infrastructure/r2/run-artifacts.ts";
import { checkRunnerHealth } from "../infrastructure/cloudflare/runner-health.ts";
import { runStarter } from "../infrastructure/cloudflare/run-start.ts";
import { createRunnerHealthRoutes } from "../presentation/http/runner-health.ts";
import { admitTrigger } from "../infrastructure/d1/trigger-admission.ts";
import { Hono } from "hono";
import type { ApplyGlobalResponse } from "hono/client";
import { cors } from "hono/cors";
import { createGithubWebhook } from "../presentation/http/github-webhook.ts";
import { createConnectRoutes } from "../presentation/http/connect.ts";
import { createLoginRoutes } from "../presentation/http/login.ts";
import { createRefreshRoutes } from "../presentation/http/refresh.ts";
import { type Bindings } from "../bindings.ts";
import { createRunRoutes } from "../presentation/http/runs.ts";
import { createSessionRoutes } from "../presentation/http/sessions.ts";
import { d1Sessions } from "../infrastructure/d1/sessions.ts";
import { createTriggerRoutes } from "../presentation/http/triggers.ts";

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

const browserApi = new Hono<{ Bindings: Bindings }>()
  .use(
    "*",
    cors({
      origin: (origin, c) =>
        origin === c.env?.TAILOS_WEB_ORIGIN ? origin : undefined,
      credentials: true,
      allowMethods: ["GET", "POST"],
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
  .route("/sessions", userSessionRoutes);

export type BrowserApi = ApplyGlobalResponse<
  typeof browserApi,
  {
    401: { json: { error: "unauthorized" } };
    403: { json: { error: "forbidden" } };
    404: { json: { error: "not_found" } };
  }
>;

app.route("/api", browserApi);
app.route("/api/auth", loginRoutes);
app.route("/webhooks/github", githubWebhook);
app.route("/_runner/runs", refreshRoutes);
app.get("/health", (c) => c.json({ status: "ok", service: "tailos-api" }));
app.route("/_internal/runs", runRoutes);
app.route("/_internal/sessions", sessionRoutes);
app.route("/_internal/triggers", triggerRoutes);

app.route("/_internal/runner", runnerHealth);

export default app;

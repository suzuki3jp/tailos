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
import { createGithubWebhook } from "../presentation/http/github-webhook.ts";
import { createConnectRoutes } from "../presentation/http/connect.ts";
import { createRefreshRoutes } from "../presentation/http/refresh.ts";
import { createLoginRoutes } from "../presentation/http/login.ts";
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

const loginRoutes = createLoginRoutes(createLoginAuth, getOperatorSession);

const connectRoutes = createConnectRoutes(operatorAuth);

const runnerHealth = createRunnerHealthRoutes((env) =>
  checkRunnerHealth(env.RUNNER),
);

const app = new Hono<{ Bindings: Bindings }>();

app.route("/connect", connectRoutes);
app.route("/sessions", userSessionRoutes);
app.route("/webhooks/github", githubWebhook);
app.route("/_runner/runs", refreshRoutes);
app.route("/", loginRoutes);
app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/_internal/runs", runRoutes);
app.route("/_internal/sessions", sessionRoutes);
app.route("/_internal/triggers", triggerRoutes);

app.route("/_internal/runner", runnerHealth);

export default app;

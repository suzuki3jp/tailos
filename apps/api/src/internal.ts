import type {
  D1Database,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { bearerAuth } from "hono/bearer-auth";
import { createMiddleware } from "hono/factory";

import type { RunArtifactsBucket } from "./run-artifacts.ts";
import type { RunnerContainer } from "./runner-container.ts";

export type Bindings = {
  DB: D1Database;
  RUN_ARTIFACTS?: RunArtifactsBucket;
  RUNNER?: DurableObjectNamespace<RunnerContainer>;
  MEGURI_TEST_TOKEN?: string;
  MEGURI_PUBLIC_ORIGIN?: string;
  BETTER_AUTH_SECRET?: string;
  MEGURI_GITHUB_OAUTH_CLIENT_ID?: string;
  MEGURI_GITHUB_OAUTH_CLIENT_SECRET?: string;
  MEGURI_OPERATOR_GITHUB_ID?: string;
};

export const smokeOwnerId = "internal-smoke";

export const smokeAuth = createMiddleware<{ Bindings: Bindings }>(
  async (c, next) => {
    const token = c.env?.MEGURI_TEST_TOKEN;
    if (!token) return c.notFound();
    return bearerAuth<{ Bindings: Bindings }>({ token })(c, next);
  },
);

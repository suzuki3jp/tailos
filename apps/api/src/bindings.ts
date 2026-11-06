import type {
  D1Database,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";

import type { RunArtifactsBucket } from "./infrastructure/r2/run-artifacts.ts";
import type { RunnerContainer } from "./infrastructure/cloudflare/runner-container.ts";

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

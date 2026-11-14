import type {
  D1Database,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";

import type { ConnectionControl } from "@/application/auth/device.ts";
import type { RunArtifactsBucket } from "@/infrastructure/r2/run-artifacts.ts";
import type { RunnerContainer } from "@/infrastructure/cloudflare/runner-container.ts";

export type Bindings = {
  DB: D1Database;
  RUN_ARTIFACTS?: RunArtifactsBucket;
  RUNNER?: DurableObjectNamespace<RunnerContainer>;
  TAILOS_TEST_TOKEN?: string;
  TAILOS_GH_APP_ID?: string;
  TAILOS_GH_APP_PRIVATE_KEY?: string;
  TAILOS_GH_WEBHOOK_SECRET?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CREDENTIALS?: { getByName(name: string): ConnectionControl };
  TAILOS_PUBLIC_ORIGIN?: string;
  TAILOS_WEB_ORIGIN?: string;
  BETTER_AUTH_SECRET?: string;
  TAILOS_GITHUB_OAUTH_CLIENT_ID?: string;
  TAILOS_GITHUB_OAUTH_CLIENT_SECRET?: string;
  TAILOS_OPERATOR_GITHUB_ID?: string;
};

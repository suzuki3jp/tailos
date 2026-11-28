import type {
  D1Database,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";

import type { ClaudeConnectionControl } from "@/application/auth/claude.ts";
import type { ConnectionControl } from "@/application/auth/device.ts";
import type { BrowserApiOrigins } from "@/application/auth/login.ts";
import type { RunArtifactsBucket } from "@/infrastructure/r2/run-artifacts.ts";
import type { RunnerContainer } from "@/infrastructure/cloudflare/runner-container.ts";
import type { SessionStream } from "@/infrastructure/cloudflare/session-stream.ts";

export type Bindings = BrowserApiOrigins & {
  DB: D1Database;
  RUN_ARTIFACTS?: RunArtifactsBucket;
  RUNNER?: DurableObjectNamespace<RunnerContainer>;
  SESSION_STREAM?: {
    getByName(name: string): Pick<SessionStream, "notify"> & {
      fetch(
        input: string,
        init: { headers: Record<string, string> },
      ): Promise<Response>;
    };
  };
  TAILOS_TEST_TOKEN?: string;
  TAILOS_GH_APP_ID?: string;
  TAILOS_GH_APP_PRIVATE_KEY?: string;
  TAILOS_GH_WEBHOOK_SECRET?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CREDENTIALS?: {
    getByName(name: string): ConnectionControl & ClaudeConnectionControl;
  };
  BETTER_AUTH_SECRET?: string;
  TAILOS_PREVIEW?: "true";
  TAILOS_GITHUB_OAUTH_CLIENT_ID?: string;
  TAILOS_GITHUB_OAUTH_CLIENT_SECRET?: string;
  TAILOS_OPERATOR_GITHUB_ID?: string;
};

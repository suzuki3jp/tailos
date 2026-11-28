import type { D1Database, DurableObjectId } from "@cloudflare/workers-types";
import type { DiagnosticBatch } from "@tailos/core/diagnostics";

import type { ClaudeConnectionControl } from "@/application/auth/claude.ts";
import type { ConnectionControl } from "@/application/auth/device.ts";
import type { BrowserApiOrigins } from "@/application/auth/login.ts";

/** The Run's current Codex access, issued outside the container. */
export type ModelAccess = {
  accessToken: string;
  accountId: string;
  accessVersion: string;
};

/** RPC methods used by the API Worker and the egress entrypoints. */
export interface RunnerControl {
  schedule(runId: string, sessionId: string): Promise<void>;
  checkHealth(): Promise<boolean>;
  cleanupDiagnostics(): Promise<void>;
  ingestDiagnostics(
    runId: string,
    bearer: string,
    batch: DiagnosticBatch,
  ): Promise<boolean | "limit">;
  githubToken(runId?: string): Promise<string | null>;
  recordPush(
    runId: string | undefined,
    repository: string,
    branches: string[],
  ): Promise<void>;
  claudeAccess(runId?: string): Promise<string | null>;
  modelAccess(runId?: string): Promise<ModelAccess | null>;
  rejectModelAccess(
    runId: string | undefined,
    accessVersion: string,
  ): Promise<void>;
}

export interface SessionStreamControl {
  notify(sessionId: string): Promise<void>;
}

export type RunArtifactsBucket = {
  // The body is the R2 object's stream, typed by the Workers runtime.
  get(key: string): Promise<{
    text(): Promise<string>;
    body?: unknown;
  } | null>;
  put(key: string, contents: string): Promise<unknown>;
  delete?(key: string): Promise<void>;
  list?(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
};

export type Bindings = BrowserApiOrigins & {
  DB: D1Database;
  RUN_ARTIFACTS?: RunArtifactsBucket;
  RUNNER?: {
    getByName(name: string): RunnerControl;
    get(id: DurableObjectId): RunnerControl;
    newUniqueId(): DurableObjectId;
  };
  SESSION_STREAM?: {
    getByName(name: string): SessionStreamControl & {
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

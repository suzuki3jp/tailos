import type {
  D1Database,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";

import type { RunnerContainer } from "./infrastructure/cloudflare/runner-container.ts";

export type Bindings = {
  DB: D1Database;
  RUNNER?: DurableObjectNamespace<RunnerContainer>;
  MEGURI_TEST_TOKEN?: string;
};

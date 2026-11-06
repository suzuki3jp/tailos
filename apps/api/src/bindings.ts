import type { D1Database } from "@cloudflare/workers-types";

export type Bindings = {
  DB: D1Database;
  MEGURI_TEST_TOKEN?: string;
};

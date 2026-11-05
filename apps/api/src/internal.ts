import type { D1Database } from "@cloudflare/workers-types";
import { bearerAuth } from "hono/bearer-auth";
import { createMiddleware } from "hono/factory";

export type Bindings = {
  DB: D1Database;
  MEGURI_TEST_TOKEN?: string;
};

export const smokeOwnerId = "internal-smoke";

export const smokeAuth = createMiddleware<{ Bindings: Bindings }>(
  async (c, next) => {
    const token = c.env?.MEGURI_TEST_TOKEN;
    if (!token) return c.notFound();
    return bearerAuth<{ Bindings: Bindings }>({ token })(c, next);
  },
);

import { bearerAuth } from "hono/bearer-auth";
import { createMiddleware } from "hono/factory";
import type { Bindings } from "../../bindings.ts";

export const smokeOwnerId = "internal-smoke";

export const smokeAuth = createMiddleware<{ Bindings: Bindings }>(
  async (c, next) => {
    const token = c.env?.TAILOS_TEST_TOKEN;
    if (!token) return c.notFound();
    return bearerAuth<{ Bindings: Bindings }>({ token })(c, next);
  },
);

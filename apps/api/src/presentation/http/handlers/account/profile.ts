import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { OperatorEnv } from "@/presentation/http/middlewares/operator.ts";

type Profile = { name: string; email: string; image: string | null };

export function createAccountProfileRoutes(
  readProfile: (
    env: OperatorEnv["Bindings"],
    userId: string,
  ) => Promise<Profile | null>,
  operatorAuth: MiddlewareHandler<OperatorEnv>,
) {
  return new Hono<OperatorEnv>().get("/profile", operatorAuth, async (c) => {
    const profile = await readProfile(c.env, c.get("operatorUserId"));
    return profile
      ? c.json(profile)
      : c.json({ error: "not_found" as const }, 404);
  });
}

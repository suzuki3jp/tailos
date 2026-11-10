import { Hono } from "hono";
import type {
  createOperatorAuth,
  OperatorEnv,
} from "../../middlewares/operator.ts";
import type { Bindings } from "../../../../bindings.ts";
import { codexConnectionId } from "../../../../application/auth/device.ts";

type ConnectEnv = {
  Bindings: Bindings;
  Variables: OperatorEnv["Variables"] & {
    broker: ReturnType<NonNullable<Bindings["CREDENTIALS"]>["getByName"]>;
  };
};

export function createConnectRoutes(
  operatorAuth: ReturnType<typeof createOperatorAuth>,
) {
  return new Hono<ConnectEnv>()
    .use("*", operatorAuth)
    .use("*", async (c, next) => {
      const bindings = c.env.CREDENTIALS;
      if (!c.env.CREDENTIAL_ENCRYPTION_KEY || !bindings)
        return c.json({ error: "not_found" as const }, 404);
      c.set(
        "broker",
        bindings.getByName(codexConnectionId(c.var.operatorUserId)),
      );
      await next();
    })
    .get("/", async (c) => {
      const status = await c.var.broker.status().catch(() => {
        // oxlint-disable-next-line no-console -- Record the failed RPC without its error or payload.
        console.warn({
          event: "chatgpt_connection_step_failed",
          stage: "read_connection_status",
          retrying: false,
        });
        return { state: "failed" as const };
      });
      return c.json(status);
    })
    .post("/start", async (c) => {
      await c.var.broker.begin();
      return c.json({ ok: true as const });
    })
    .post("/disconnect", async (c) => {
      await c.var.broker.disconnect();
      return c.json({ ok: true as const });
    });
}

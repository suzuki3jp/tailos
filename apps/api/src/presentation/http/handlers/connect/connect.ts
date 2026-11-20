import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import type {
  createOperatorAuth,
  OperatorEnv,
} from "@/presentation/http/middlewares/operator.ts";
import type { Bindings } from "@/bindings.ts";
import { ClaudeToken, claudeConnectionId } from "@/application/auth/claude.ts";
import { codexConnectionId } from "@/application/auth/device.ts";

const claudeInput = v.strictObject({ token: ClaudeToken });

type ConnectEnv = {
  Bindings: Bindings;
  Variables: OperatorEnv["Variables"] & {
    credentials: NonNullable<Bindings["CREDENTIALS"]>;
  };
};

// Each Agent keeps its connection in a Durable Object of its own.
const codex = (c: Context<ConnectEnv>) =>
  c.var.credentials.getByName(codexConnectionId(c.var.operatorUserId));
const claude = (c: Context<ConnectEnv>) =>
  c.var.credentials.getByName(claudeConnectionId(c.var.operatorUserId));

export function createConnectRoutes(
  operatorAuth: ReturnType<typeof createOperatorAuth>,
) {
  return (
    new Hono<ConnectEnv>()
      .use("*", operatorAuth)
      .use("*", async (c, next) => {
        const bindings = c.env.CREDENTIALS;
        if (!c.env.CREDENTIAL_ENCRYPTION_KEY || !bindings)
          return c.json({ error: "not_found" as const }, 404);
        c.set("credentials", bindings);
        await next();
      })
      .get("/", async (c) => {
        const status = await codex(c)
          .status()
          .catch(() => {
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
      .get("/codex/models", async (c) => {
        const models = await codex(c)
          .codexModels?.()
          .catch(() => null);
        return models === undefined || models === null
          ? c.json({ error: "catalog_unavailable" as const }, 503)
          : c.json({ models });
      })
      .post("/start", async (c) => {
        await codex(c).begin();
        return c.json({ ok: true as const });
      })
      .post("/disconnect", async (c) => {
        await codex(c).disconnect();
        return c.json({ ok: true as const });
      })
      .get("/claude", async (c) => c.json(await claude(c).claudeStatus()))
      // The token is never echoed back: not in a response and not in a log.
      .post("/claude", bodyLimit({ maxSize: 4096 }), async (c) => {
        const parsed = v.safeParse(
          claudeInput,
          await c.req.json().catch(() => null),
        );
        if (!parsed.success)
          return c.json({ error: "invalid_token" as const }, 400);
        return (await claude(c).saveClaudeToken(parsed.output.token))
          ? c.json({ ok: true as const })
          : c.json({ error: "already_connected" as const }, 409);
      })
      .post("/claude/disconnect", async (c) => {
        await claude(c).disconnect();
        return c.json({ ok: true as const });
      })
  );
}

import { Hono } from "hono";
import type { createOperatorAuth, OperatorEnv } from "./operator.ts";
import { jsx } from "hono/jsx";
import type { Bindings } from "../../bindings.ts";
import {
  codexConnectionId,
  type ConnectionStatus,
} from "../../application/auth/device.ts";

const path = "/connect";
const messages = {
  disconnected: "ChatGPT アカウントを接続できます。",
  connected: "ChatGPT に接続済みです。",
  expired: "コードの有効期限が切れました。もう一度接続してください。",
  failed: "接続できませんでした。少し待ってから再試行してください。",
};

function page(status: ConnectionStatus) {
  const action = (endpoint: string, label: string) =>
    jsx(
      "form",
      { method: "post", action: path + endpoint },
      jsx("button", { type: "submit" }, label),
    );
  const content =
    status.state === "pending"
      ? [
          jsx("p", null, "ChatGPT で次のコードを入力してください。"),
          jsx("p", null, jsx("code", null, status.userCode)),
          jsx(
            "a",
            {
              href: status.verificationUrl,
              target: "_blank",
              rel: "noopener noreferrer",
            },
            "ChatGPT を開く",
          ),
          jsx("p", null, "この画面は接続が完了すると自動で更新されます。"),
        ]
      : [
          jsx("p", null, messages[status.state]),
          status.state === "connected"
            ? action("/disconnect", "接続を解除")
            : action("/start", "ChatGPT に接続"),
        ];

  return jsx(
    "html",
    { lang: "ja" },
    jsx(
      "head",
      null,
      jsx("meta", { charset: "utf-8" }),
      jsx("meta", {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      }),
      jsx("title", null, "Meguri · ChatGPT 接続"),
      status.state === "pending"
        ? jsx("meta", { "http-equiv": "refresh", content: "5" })
        : null,
    ),
    jsx(
      "body",
      null,
      jsx("main", null, jsx("h1", null, "ChatGPT 接続"), ...content),
    ),
  );
}

type ConnectEnv = {
  Bindings: Bindings;
  Variables: OperatorEnv["Variables"] & {
    broker: ReturnType<NonNullable<Bindings["CREDENTIALS"]>["getByName"]>;
  };
};

export function createConnectRoutes(
  operatorAuth: ReturnType<typeof createOperatorAuth>,
) {
  const connectRoutes = new Hono<ConnectEnv>();
  connectRoutes.use("*", operatorAuth);
  connectRoutes.use("*", async (c, next) => {
    const bindings = c.env.CREDENTIALS;
    if (!c.env.CREDENTIAL_ENCRYPTION_KEY || !bindings) return c.notFound();

    c.header(
      "Content-Security-Policy",
      "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    c.header("Referrer-Policy", "same-origin");
    c.set(
      "broker",
      bindings.getByName(codexConnectionId(c.var.operatorUserId)),
    );
    await next();
  });

  connectRoutes.get("/", async (c) => {
    const status = await c.var.broker.status().catch(() => {
      // oxlint-disable-next-line no-console -- Record the failed RPC without its error or payload.
      console.warn({
        event: "chatgpt_connection_step_failed",
        stage: "read_connection_status",
        retrying: false,
      });
      return { state: "failed" as const };
    });
    return c.html("<!doctype html>" + page(status).toString());
  });
  connectRoutes.post("/start", async (c) => {
    await c.var.broker.begin();
    return c.redirect(path, 303);
  });
  connectRoutes.post("/disconnect", async (c) => {
    await c.var.broker.disconnect();
    return c.redirect(path, 303);
  });

  return connectRoutes;
}

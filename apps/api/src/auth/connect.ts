import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { jsx } from "hono/jsx";
import type { Bindings } from "../internal.ts";
import { defaultCodexConnection, type ConnectionStatus } from "./device.ts";

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
  Variables: {
    broker: ReturnType<NonNullable<Bindings["CREDENTIALS"]>["getByName"]>;
  };
};

export const connectRoutes = new Hono<ConnectEnv>();
connectRoutes.use("*", async (c, next) => {
  const token = c.env?.MEGURI_OPERATOR_TOKEN;
  if (!token || !c.env.CREDENTIAL_ENCRYPTION_KEY || !c.env.CREDENTIALS)
    return c.notFound();

  const url = new URL(c.req.url);
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !local) return c.notFound();

  c.header("Cache-Control", "private, no-store");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  c.header("Referrer-Policy", "no-referrer");
  if (c.req.method === "POST" && c.req.header("Origin") !== url.origin) {
    return c.text("Forbidden", 403);
  }

  return basicAuth({ username: "meguri", password: token, realm: "Meguri" })(
    c,
    async () => {
      const bindings = c.env.CREDENTIALS;
      if (!bindings) return;
      c.set("broker", bindings.getByName(defaultCodexConnection));
      await next();
    },
  );
});

connectRoutes.get("/", async (c) => {
  const status = await c.var.broker
    .status()
    .catch(() => ({ state: "failed" as const }));
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

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { createTestBindings } from "@/infrastructure/d1/testing.ts";

test("the MCP SDK and key verification run inside the deployed workerd compatibility profile", async (t) => {
  const owner = "306443bc-60f2-4ce4-b356-310abbe634fd";
  const key = "tailos_read_" + "x".repeat(43);
  const origin = "https://api.tailos.example";
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./http.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "browser"],
    external: ["node:*"],
  });
  const { worker, DB } = await createTestBindings(t, {
    script: bundle.outputFiles[0].text,
    bindings: {
      TAILOS_PUBLIC_ORIGIN: origin,
      TAILOS_OPERATOR_GITHUB_ID: "123",
      TAILOS_MCP_ENABLED: "true",
      TAILOS_MCP_READ_KEY_CONFIG: JSON.stringify({
        version: 1,
        ownerId: owner,
        sha256: createHash("sha256").update(key).digest("hex"),
        expiresAt: Date.now() + 60_000,
      }),
    },
  });
  await DB.prepare(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Operator', 'operator@example.test', 1, 1, 1)",
  )
    .bind(owner)
    .run();
  await DB.prepare(
    "INSERT INTO auth_accounts (id, user_id, account_id, provider_id, created_at, updated_at) VALUES (?, ?, '123', 'github', 1, 1)",
  )
    .bind(crypto.randomUUID(), owner)
    .run();
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "tools/call",
  };
  async function call(name: string) {
    const response = await worker.dispatchFetch(origin + "/mcp", {
      method: "POST",
      headers: { ...headers, "Mcp-Name": name },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    return JSON.parse(body).result.structuredContent;
  }
  expect((await call("get_usage")).service).toBe("Tailos read-only inspection");
  expect(await call("list_sessions")).toEqual({ items: [], nextCursor: null });
});

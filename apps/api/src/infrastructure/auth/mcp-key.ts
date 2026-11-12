import { timingSafeEqual } from "node:crypto";
import {
  parseMcpKeyConfig,
  type McpAuthentication,
} from "@/application/auth/mcp-key.ts";
import type { Bindings } from "@/bindings.ts";
import { findOperatorUserId } from "@/infrastructure/auth/login.ts";

export async function authenticateMcpKey(
  env: Bindings,
  headers: Headers,
): Promise<McpAuthentication> {
  const config = parseMcpKeyConfig(env.TAILOS_MCP_READ_KEY_CONFIG);
  if (env.TAILOS_MCP_ENABLED !== "true" || !config)
    return { state: "disabled" };

  const token = headers
    .get("Authorization")
    ?.match(/^Bearer (tailos_read_[A-Za-z0-9_-]{43})$/i)?.[1];
  if (!token || Date.now() >= config.expiresAt)
    return { state: "unauthorized" };

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  if (
    !timingSafeEqual(new Uint8Array(digest), Buffer.from(config.sha256, "hex"))
  )
    return { state: "unauthorized" };

  // Changing the configured GitHub operator must not transfer an old key's
  // authority to the new operator's data.
  if (config.ownerId !== (await findOperatorUserId(env)))
    return { state: "unauthorized" };
  return { state: "authenticated", ownerId: config.ownerId };
}

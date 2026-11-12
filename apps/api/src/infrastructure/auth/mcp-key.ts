import {
  hashMcpKey,
  type McpAuthentication,
} from "@/application/auth/mcp-key.ts";
import type { Bindings } from "@/bindings.ts";
import { findOperatorUserId } from "@/infrastructure/auth/login.ts";
import { d1McpKeys } from "@/infrastructure/d1/mcp-keys.ts";

export async function authenticateMcpKey(
  env: Bindings,
  headers: Headers,
): Promise<McpAuthentication> {
  if (!env.TAILOS_OPERATOR_GITHUB_ID) return { state: "disabled" };

  const token = headers
    .get("Authorization")
    ?.match(/^Bearer (tailos_read_[A-Za-z0-9_-]{43})$/i)?.[1];
  if (!token) return { state: "unauthorized" };

  const ownerId = await d1McpKeys(env.DB).owner(
    await hashMcpKey(token),
    Date.now(),
  );
  if (!ownerId) return { state: "unauthorized" };

  // Changing the configured GitHub operator must not transfer an old key's
  // authority to the new operator's data.
  if (ownerId !== (await findOperatorUserId(env)))
    return { state: "unauthorized" };
  return { state: "authenticated", ownerId };
}

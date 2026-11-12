import type { D1Database } from "@cloudflare/workers-types";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { McpKeyStore } from "@/application/auth/mcp-key.ts";
import { mcpKeys } from "@/infrastructure/d1/schema.ts";

export function d1McpKeys(database: D1Database): McpKeyStore {
  const db = drizzle(database);
  return {
    list(ownerId) {
      return db
        .select({
          id: mcpKeys.id,
          name: mcpKeys.name,
          prefix: mcpKeys.prefix,
          createdAt: mcpKeys.createdAt,
          expiresAt: mcpKeys.expiresAt,
        })
        .from(mcpKeys)
        .where(and(eq(mcpKeys.ownerId, ownerId), isNull(mcpKeys.revokedAt)))
        .orderBy(desc(mcpKeys.createdAt), desc(mcpKeys.id));
    },
    async create(ownerId, key) {
      // Admission and the insert are one statement, so concurrent requests
      // cannot exceed the 20-key limit. Expired keys can be revoked in the UI.
      const result = await database
        .prepare(`INSERT INTO mcp_keys (id, owner_id, name, prefix, sha256, created_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE
        (SELECT count(*) FROM mcp_keys WHERE owner_id = ? AND revoked_at IS NULL) < 20`)
        .bind(
          key.id,
          ownerId,
          key.name,
          key.prefix,
          key.sha256,
          key.createdAt,
          key.expiresAt,
          ownerId,
        )
        .run();
      return result.meta.changes === 1;
    },
    async revoke(ownerId, id, now) {
      const [key] = await db
        .update(mcpKeys)
        .set({ revokedAt: sql`coalesce(${mcpKeys.revokedAt}, ${now})` })
        .where(and(eq(mcpKeys.id, id), eq(mcpKeys.ownerId, ownerId)))
        .returning({ id: mcpKeys.id });
      return Boolean(key);
    },
    async owner(sha256, now) {
      const [key] = await db
        .select({ ownerId: mcpKeys.ownerId })
        .from(mcpKeys)
        .where(
          and(
            eq(mcpKeys.sha256, sha256),
            isNull(mcpKeys.revokedAt),
            gt(mcpKeys.expiresAt, now),
          ),
        )
        .limit(1);
      return key?.ownerId ?? null;
    },
  };
}

import type { D1Database } from "@cloudflare/workers-types";
import { and, asc, desc, eq, exists, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SessionStore } from "@/application/sessions/create-session.ts";
import { runs, sessionMessages, sessions } from "@/infrastructure/d1/schema.ts";
import type { SessionListStore } from "@/application/sessions/list-sessions.ts";
import * as v from "valibot";

const triggerSchema = v.object({
  kind: v.literal("github.issue"),
  repository: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  number: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

function readTrigger(json: string | null) {
  try {
    const trigger = v.parse(triggerSchema, JSON.parse(json ?? "null"));
    return {
      ...trigger,
      url: `https://github.com/${trigger.repository}/issues/${trigger.number}`,
    };
  } catch {
    return null;
  }
}

export function d1Sessions(database: D1Database) {
  const db = drizzle(database);
  return {
    async list(
      ...[ownerId, limit, before]: Parameters<SessionListStore["list"]>
    ) {
      const rows = await db
        .select({
          id: sessions.id,
          title: sessions.title,
          trigger: sessions.trigger,
          projectId: sessions.projectId,
          createdAt: sessions.createdAt,
          updatedAt: sessions.updatedAt,
          runId: runs.id,
          runStatus: runs.status,
          errorCode: runs.errorCode,
        })
        .from(sessions)
        .leftJoin(
          runs,
          eq(
            runs.id,
            sql`(SELECT id FROM runs WHERE session_id = ${sessions.id} ORDER BY created_at DESC, id DESC LIMIT 1)`,
          ),
        )
        .where(
          and(
            eq(sessions.ownerId, ownerId),
            before
              ? or(
                  lt(sessions.updatedAt, before.updatedAt),
                  and(
                    eq(sessions.updatedAt, before.updatedAt),
                    lt(sessions.id, before.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(sessions.updatedAt), desc(sessions.id))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        trigger: readTrigger(row.trigger),
        project: row.projectId ? { id: row.projectId } : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        latestRun:
          row.runId && row.runStatus
            ? { id: row.runId, status: row.runStatus, errorCode: row.errorCode }
            : null,
      }));
    },
    async create({
      messages,
      ...session
    }: Parameters<SessionStore<unknown>["create"]>[0]) {
      await db.batch([
        db.insert(sessions).values(session),
        ...messages.map((message) =>
          db.insert(sessionMessages).values(message),
        ),
      ]);
    },
    async read(id: string, owner: string) {
      const ownedSession = db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.ownerId, owner)));
      // Read the reply and Run status from the same D1 snapshot.
      const [[session], messages, executions] = await db.batch([
        ownedSession,
        db
          .select()
          .from(sessionMessages)
          .where(and(eq(sessionMessages.sessionId, id), exists(ownedSession)))
          .orderBy(asc(sessionMessages.seq)),
        db
          .select({
            id: runs.id,
            status: runs.status,
            result: runs.result,
            errorCode: runs.errorCode,
          })
          .from(runs)
          .where(and(eq(runs.sessionId, id), exists(ownedSession)))
          .orderBy(asc(runs.createdAt), asc(runs.id)),
      ]);
      if (!session) return null;
      return { session, messages, runs: executions };
    },
  };
}

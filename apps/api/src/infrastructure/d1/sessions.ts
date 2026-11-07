import type { D1Database } from "@cloudflare/workers-types";
import { and, asc, eq, exists } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SessionStore } from "../../application/sessions/create-session.ts";
import { runs, sessionMessages, sessions } from "./schema.ts";

export function d1Sessions(database: D1Database) {
  const db = drizzle(database);
  return {
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

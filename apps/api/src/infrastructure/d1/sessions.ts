import type { D1Database } from "@cloudflare/workers-types";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SessionStore } from "../../application/sessions/create-session.ts";
import { sessionMessages, sessions } from "./schema.ts";

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
      const [session] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.ownerId, owner)));
      if (!session) return null;

      const messages = await db
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, id))
        .orderBy(asc(sessionMessages.seq));
      return { session, messages };
    },
  };
}

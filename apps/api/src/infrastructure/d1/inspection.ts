import type { D1Database } from "@cloudflare/workers-types";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type {
  InspectionStore,
  Position,
} from "@/application/inspection/inspection.ts";
import { runs, sessionMessages, sessions } from "@/infrastructure/d1/schema.ts";

function page<T extends Position>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}

const sessionFields = {
  id: sessions.id,
  projectId: sessions.projectId,
  target: sessions.target,
  createdAt: sessions.createdAt,
};
const runFields = {
  id: runs.id,
  sessionId: runs.sessionId,
  startMessageId: runs.startMessageId,
  status: runs.status,
  errorCode: runs.errorCode,
  createdAt: runs.createdAt,
  finishedAt: runs.finishedAt,
  deadlineAt: runs.deadlineAt,
};

export function d1Inspection(
  database: D1Database,
): Omit<
  InspectionStore,
  "readRunArtifact" | "diagnostics" | "readDiagnosticArtifact"
> {
  const db = drizzle(database);
  return {
    async listSessions(ownerId, input) {
      const rows = await db
        .select(sessionFields)
        .from(sessions)
        .where(
          and(
            eq(sessions.ownerId, ownerId),
            input.projectId !== undefined
              ? eq(sessions.projectId, input.projectId)
              : undefined,
            input.target !== undefined
              ? eq(sessions.target, input.target)
              : undefined,
            input.before
              ? sql`(${sessions.createdAt}, ${sessions.id}) < (${input.before.createdAt}, ${input.before.id})`
              : undefined,
          ),
        )
        .orderBy(desc(sessions.createdAt), desc(sessions.id))
        .limit(input.limit + 1);
      return page(rows, input.limit);
    },
    async getSession(ownerId, id, afterSeq, limit) {
      const [[session], rows] = await db.batch([
        db
          .select(sessionFields)
          .from(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.ownerId, ownerId))),
        db
          .select({
            id: sessionMessages.id,
            seq: sessionMessages.seq,
            authorKind: sessionMessages.authorKind,
            runId: sessionMessages.runId,
            createdAt: sessionMessages.createdAt,
            body: sql<string>`substr(${sessionMessages.body}, 1, 1000)`,
            bodyLength: sql<number>`length(${sessionMessages.body})`,
          })
          .from(sessionMessages)
          .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
          .where(
            and(
              eq(sessions.id, id),
              eq(sessions.ownerId, ownerId),
              gt(sessionMessages.seq, afterSeq),
            ),
          )
          .orderBy(sessionMessages.seq)
          .limit(limit + 1),
      ]);
      if (!session) return null;
      const items = rows.slice(0, limit);
      return {
        session,
        messages: items,
        nextAfterSeq: rows.length > limit ? (items.at(-1)?.seq ?? null) : null,
      };
    },
    async readMessage(ownerId, id, offset, limit) {
      const [row] = await db
        .select({
          text: sql<string>`substr(${sessionMessages.body}, ${offset + 1}, ${limit})`,
          totalLength: sql<number>`length(${sessionMessages.body})`,
        })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(and(eq(sessionMessages.id, id), eq(sessions.ownerId, ownerId)))
        .limit(1);
      if (!row) return null;
      return {
        ...row,
        nextOffset: offset + limit < row.totalLength ? offset + limit : null,
      };
    },
    async listRuns(ownerId, input) {
      const rows = await db
        .select(runFields)
        .from(runs)
        .innerJoin(sessions, eq(sessions.id, runs.sessionId))
        .where(
          and(
            eq(sessions.ownerId, ownerId),
            input.sessionId !== undefined
              ? eq(runs.sessionId, input.sessionId)
              : undefined,
            input.status !== undefined
              ? eq(runs.status, input.status)
              : undefined,
            input.before
              ? sql`(${runs.createdAt}, ${runs.id}) < (${input.before.createdAt}, ${input.before.id})`
              : undefined,
          ),
        )
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(input.limit + 1);
      return page(rows, input.limit);
    },
    async getRun(ownerId, id) {
      const [row] = await db
        .select({ ...runFields, result: runs.result })
        .from(runs)
        .innerJoin(sessions, eq(sessions.id, runs.sessionId))
        .where(and(eq(runs.id, id), eq(sessions.ownerId, ownerId)))
        .limit(1);
      return row ?? null;
    },
  };
}

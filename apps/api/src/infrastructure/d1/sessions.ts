import type { D1Database } from "@cloudflare/workers-types";
import { ExecutionContext, githubJobContext } from "@tailos/core/runner";
import { and, asc, desc, eq, exists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SessionStore } from "@/application/sessions/create-session.ts";
import {
  diagnosticEvents,
  diagnosticTraces,
  projects,
  runs,
  sessionMessages,
  sessions,
} from "@/infrastructure/d1/schema.ts";
import type { SessionListStore } from "@/application/sessions/list-sessions.ts";
import * as v from "valibot";
import { timelineSnapshotFields, readTimelineSnapshot } from "./timeline.ts";

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

function readJobContext(json: string | null) {
  if (!json) return undefined;
  try {
    const context = v.safeParse(ExecutionContext, JSON.parse(json));
    const github = context.success
      ? githubJobContext(context.output)
      : undefined;
    return github ? { github } : undefined;
  } catch {
    return undefined;
  }
}

export function d1Sessions(database: D1Database) {
  const db = drizzle(database);
  return {
    async list(
      ...[ownerId, limit, before, projectId]: Parameters<
        SessionListStore["list"]
      >
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
            projectId === undefined
              ? undefined
              : eq(sessions.projectId, projectId),
            before
              ? sql`(${sessions.updatedAt}, ${sessions.id}) < (${before.updatedAt}, ${before.id})`
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
    async read(id: string, owner: string, projectId?: string) {
      const ownedSession = db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, id),
            eq(sessions.ownerId, owner),
            projectId === undefined
              ? undefined
              : eq(sessions.projectId, projectId),
          ),
        );
      // Read the reply and Run status from the same D1 snapshot.
      const [[session], messages, executions, timeline] = await db.batch([
        ownedSession,
        db
          .select({
            message: sessionMessages,
            executionContext: runs.executionContext,
          })
          .from(sessionMessages)
          .leftJoin(
            runs,
            and(
              eq(sessionMessages.seq, 1),
              eq(runs.sessionId, sessionMessages.sessionId),
              eq(runs.startMessageId, sessionMessages.id),
            ),
          )
          .where(and(eq(sessionMessages.sessionId, id), exists(ownedSession)))
          .orderBy(asc(sessionMessages.seq)),
        db
          .select({
            id: runs.id,
            status: runs.status,
            result: runs.result,
            errorCode: runs.errorCode,
            startMessageId: runs.startMessageId,
            // The Model Provider the Turn ran on, which names its replies.
            engine: sql<
              string | null
            >`CASE WHEN json_valid(${runs.executionContext}) THEN json_extract(${runs.executionContext}, '$.engine') ELSE NULL END`,
            agentDurationMs: sql<number | null>`(
              SELECT sum(json_extract(${diagnosticEvents.attributes}, '$.durationMs'))
              FROM ${diagnosticEvents}
              WHERE ${diagnosticEvents.traceId} = ${diagnosticTraces.id}
                AND ${diagnosticEvents.name} = 'span.finished'
                AND json_extract(${diagnosticEvents.attributes}, '$.operation') = 'agent'
            )`,
          })
          .from(runs)
          .leftJoin(
            diagnosticTraces,
            and(
              eq(diagnosticTraces.runId, runs.id),
              eq(diagnosticTraces.ownerId, owner),
              sql`${diagnosticTraces.expiresAt} > ${Date.now()}`,
            ),
          )
          .where(and(eq(runs.sessionId, id), exists(ownedSession)))
          .orderBy(asc(runs.createdAt), asc(runs.id)),
        db
          .select(timelineSnapshotFields(id, Date.now()))
          .from(sessions)
          .where(and(eq(sessions.id, id), exists(ownedSession))),
      ]);
      if (!session) return null;
      return {
        session,
        messages: messages.map(({ message, executionContext }) => {
          const jobContext = readJobContext(executionContext);
          return { ...message, ...(jobContext && { jobContext }) };
        }),
        runs: executions,
        timeline: readTimelineSnapshot(timeline[0]),
      };
    },
    async projectName(id: string, ownerId: string) {
      const [project] = await db
        .select({ name: projects.name })
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)));
      return project?.name || null;
    },
  };
}

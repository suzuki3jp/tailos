import * as v from "valibot";
import {
  decodePageCursor,
  encodePageCursor,
} from "@/application/pagination/cursor.ts";

export type SessionPosition = { updatedAt: number; id: string };
export type SessionSummary = SessionPosition & {
  title: string;
  trigger: {
    kind: "github.issue";
    repository: string;
    number: number;
    url: string;
  } | null;
  project: { id: string } | null;
  createdAt: number;
  latestRun: {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed";
    errorCode: string | null;
  } | null;
};
export type SessionListStore = {
  list(
    ownerId: string,
    limit: number,
    before?: SessionPosition,
    projectId?: string,
    /** Only the Sessions this Routine keeps for its issues. */
    routineId?: string,
  ): Promise<SessionSummary[]>;
};
const position = v.strictObject({
  updatedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  id: v.pipe(v.string(), v.minLength(1)),
});

export function sessionListInput(query: URLSearchParams) {
  const limits = query.getAll("limit");
  const cursors = query.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) return null;
  const raw = limits[0];
  if (raw !== undefined && !/^[0-9]+$/.test(raw)) return null;
  const limit = raw === undefined ? 50 : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  let before: SessionPosition | undefined;
  if (cursors.length) {
    try {
      before = v.parse(position, decodePageCursor(cursors[0]));
    } catch {
      return null;
    }
  }
  return { limit, before };
}

export async function listSessions(
  store: SessionListStore,
  ownerId: string,
  input: NonNullable<ReturnType<typeof sessionListInput>>,
  projectId?: string,
  routineId?: string,
) {
  const rows = await store.list(
    ownerId,
    input.limit + 1,
    input.before,
    projectId,
    routineId,
  );
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > input.limit && last
      ? encodePageCursor({ updatedAt: last.updatedAt, id: last.id })
      : null;
  return { items, nextCursor };
}

import * as v from "valibot";

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
      const cursor = cursors[0]!;
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
      const bytes = Uint8Array.from(
        atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      );
      before = v.parse(
        position,
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
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
) {
  const rows = await store.list(ownerId, input.limit + 1, input.before);
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > input.limit && last
      ? btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(
              JSON.stringify({ updatedAt: last.updatedAt, id: last.id }),
            ),
          ),
        )
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, "")
      : null;
  return { items, nextCursor };
}

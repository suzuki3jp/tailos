import type { AccountSession } from "../api/account-sessions";

/** The Sidebar and Routine detail show up to the same number of Sessions. */
export const RECENT_SESSIONS_LIMIT = 10;

/** Sessions across the loaded pages, without repeats, up to the view's limit. */
export function uniqueSessions(
  pages: readonly { items: readonly AccountSession[] }[] | undefined,
  limit: number,
) {
  const byId = new Map<string, AccountSession>();
  for (const page of pages ?? []) {
    for (const session of page.items) {
      if (!byId.has(session.id)) byId.set(session.id, session);
    }
  }
  return Array.from(byId.values()).slice(0, limit);
}

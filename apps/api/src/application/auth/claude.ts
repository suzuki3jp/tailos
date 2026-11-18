import type { ClaudeAccess } from "@tailos/core/runner";
import * as v from "valibot";

export function claudeConnectionId(userId: string) {
  return `claude/${userId}`;
}

// The shape of a long-lived OAuth token printed by `claude setup-token`. Only
// the format is checked: whether the token works shows up in the first Run.
export const ClaudeToken = v.pipe(
  v.string(),
  v.regex(/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{32,512}$/),
);

const day = 24 * 60 * 60 * 1000;
// The token is valid for one year from issue and cannot be refreshed. Tailos
// only knows when it was saved, so the expiry is counted from there.
const tokenLifetime = 365 * day;
const expiryNotice = 30 * day;

export type ClaudeConnectionStatus =
  | { state: "disconnected" }
  | {
      state: "connected";
      savedAt: number;
      expiresAt: number;
      expiry: "valid" | "soon" | "passed";
    };

export function claudeConnectionStatus(
  savedAt: number | undefined,
  now: number,
): ClaudeConnectionStatus {
  if (savedAt === undefined) return { state: "disconnected" };
  const expiresAt = savedAt + tokenLifetime;
  const nearingExpiry = now >= expiresAt - expiryNotice;
  const upcomingExpiry = nearingExpiry ? "soon" : "valid";
  return {
    state: "connected",
    savedAt,
    expiresAt,
    expiry: now >= expiresAt ? "passed" : upcomingExpiry,
  };
}

export interface ClaudeConnectionControl {
  claudeStatus(): Promise<ClaudeConnectionStatus>;
  // Resolves false when a token is already saved: disconnect first.
  saveClaudeToken(token: string): Promise<boolean>;
  issueClaudeAccess(): Promise<ClaudeAccess | null>;
}

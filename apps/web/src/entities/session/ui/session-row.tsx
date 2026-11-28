import Link from "next/link";
import {
  IconMessage,
  IconMessageDots,
  IconMessageReport,
} from "@tabler/icons-react";
import { sessionPath } from "@/shared/lib/session-path";
import type { AccountSession } from "../api/account-sessions";
import { updatedLabel } from "../model/updated-label";
import { UnreadMark } from "./unread-mark";

const statusIcons = {
  failed: IconMessageReport,
  queued: IconMessageDots,
  running: IconMessageDots,
  succeeded: IconMessage,
} satisfies Record<
  NonNullable<AccountSession["latestRun"]>["status"],
  typeof IconMessage
>;

export function SessionRow({
  session,
  now,
  unread = false,
}: {
  session: AccountSession;
  now: number;
  /** No read state exists yet, so callers leave this unset. */
  unread?: boolean;
}) {
  const status = session.latestRun?.status;
  const failed = status === "failed";
  const Icon = status ? statusIcons[status] : IconMessage;
  return (
    <div className="space-y-1.5 p-3">
      <Link
        href={sessionPath(session.id, session.project?.id)}
        title={session.title}
        className="flex items-center gap-3 rounded-sm text-foreground hover:underline"
      >
        <span className="relative shrink-0">
          <Icon
            aria-hidden="true"
            size={20}
            className="text-foreground-strong"
          />
          {unread && <UnreadMark className="absolute top-0 left-4" />}
        </span>
        <span className="min-w-0 truncate text-body">{session.title}</span>
      </Link>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 pl-9 text-caption text-muted-foreground">
        {session.trigger && (
          <Link
            href={session.trigger.url}
            className="rounded-sm hover:underline"
            title={session.trigger.repository}
          >
            Triggered by Issue #{session.trigger.number} ·{" "}
            {session.trigger.repository}
          </Link>
        )}
        <time
          dateTime={new Date(session.updatedAt).toISOString()}
          title={new Date(session.updatedAt).toISOString()}
        >
          {updatedLabel(session.updatedAt, now)}
        </time>
        {session.latestRun && (
          <span className={failed ? "text-destructive" : undefined}>
            {session.latestRun.status}
            {failed && session.latestRun.errorCode
              ? ` · ${session.latestRun.errorCode}`
              : ""}
          </span>
        )}
      </div>
    </div>
  );
}

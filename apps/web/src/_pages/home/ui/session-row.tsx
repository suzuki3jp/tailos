import Link from "next/link";
import {
  IconMessage,
  IconMessageDots,
  IconMessageReport,
} from "@tabler/icons-react";
import type { HomeSession } from "../api/queries";
import { updatedLabel } from "../model/session-presentation";

const statusIcons = {
  failed: IconMessageReport,
  queued: IconMessageDots,
  running: IconMessageDots,
  succeeded: IconMessage,
} satisfies Record<
  NonNullable<HomeSession["latestRun"]>["status"],
  typeof IconMessage
>;

export function SessionRow({
  session,
  now,
}: {
  session: HomeSession;
  now: number;
}) {
  const status = session.latestRun?.status;
  const failed = status === "failed";
  const Icon = status ? statusIcons[status] : IconMessage;
  return (
    <div className="space-y-1.5 p-3">
      <Link
        href={`/sessions/${encodeURIComponent(session.id)}`}
        className="flex items-start gap-3 rounded-sm text-foreground-strong hover:underline"
      >
        <Icon aria-hidden="true" size={20} className="shrink-0" />
        <span className="min-w-0 text-body wrap-anywhere">{session.title}</span>
      </Link>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 pl-8 text-caption text-muted-foreground">
        {session.trigger && (
          <a
            href={session.trigger.url}
            className="rounded-sm hover:underline"
            title={session.trigger.repository}
          >
            Triggered by Issue #{session.trigger.number} ·{" "}
            {session.trigger.repository}
          </a>
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

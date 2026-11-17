import { SessionList } from "./session-list";

export function RecentSessions() {
  return (
    <section
      id="recent-sessions"
      aria-labelledby="recent-sessions-heading"
      className="scroll-mt-6 space-y-2.5"
    >
      <h2
        id="recent-sessions-heading"
        className="text-section-title font-semibold text-foreground-strong"
      >
        Recent Sessions
      </h2>
      <SessionList />
    </section>
  );
}

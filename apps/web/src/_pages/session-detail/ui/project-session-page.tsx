import Link from "next/link";
import {
  IconChartHistogram,
  IconHome,
  IconMessages,
  IconSettings,
} from "@tabler/icons-react";
import { MobileNavigation } from "@/shared/ui/mobile-navigation";
import {
  ProjectSessionContent,
  SessionProjectName,
} from "./project-session-content";
import { ProjectSessionsPanel } from "./project-sessions-panel";
import { SessionPanels } from "./session-panels";

const navItem =
  "flex h-12 items-center gap-6 px-6 text-caption hover:bg-sidebar-accent";

export function ProjectSessionPage({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  return (
    <div className="flex h-dvh min-h-0 bg-background text-foreground">
      <aside
        className="hidden w-60 shrink-0 border-r bg-sidebar md:block"
        aria-label="Project sidebar"
      >
        <ProjectNavigation projectId={projectId} sessionId={sessionId} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-15 shrink-0 items-center justify-between gap-3 border-b px-3 md:justify-end">
          <MobileNavigation>
            <ProjectNavigation projectId={projectId} sessionId={sessionId} />
          </MobileNavigation>
          <Link
            href="/login"
            aria-label="Open account"
            className="shrink-0 rounded-full"
          >
            <img
              src="/assets/design-system/demo-avatar.png"
              className="rounded-full"
              width={36}
              height={36}
              alt=""
            />
          </Link>
        </header>
        <SessionPanels
          sessions={
            <ProjectSessionsPanel projectId={projectId} sessionId={sessionId} />
          }
        >
          <main
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            aria-label="Session"
          >
            <ProjectSessionContent
              key={`${projectId}/${sessionId}`}
              projectId={projectId}
              sessionId={sessionId}
            />
          </main>
        </SessionPanels>
      </div>
    </div>
  );
}

function ProjectNavigation({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  return (
    <>
      <div className="flex h-15 items-center gap-2.5 border-b px-3">
        <Link href="/" aria-label="Tailos home" className="shrink-0 rounded-md">
          <img
            src="/assets/design-system/tailos-symbol.png"
            alt=""
            width={48}
            height={48}
          />
        </Link>
        <SessionProjectName projectId={projectId} sessionId={sessionId} />
      </div>
      <nav aria-label="Main navigation" className="flex flex-col gap-9">
        <Link href="/" className={navItem}>
          <IconHome aria-hidden="true" size={20} />
          Account Home
        </Link>
        <div>
          <a
            href="#project-sessions"
            aria-current="page"
            className={`${navItem} hidden lg:flex`}
          >
            <IconMessages aria-hidden="true" size={20} />
            Sessions
          </a>
          <details className="lg:hidden">
            <summary className={`${navItem} cursor-pointer list-none`}>
              <IconMessages aria-hidden="true" size={20} />
              Sessions
            </summary>
            <ProjectSessionsPanel
              projectId={projectId}
              sessionId={sessionId}
              compact
            />
          </details>
          <button
            type="button"
            disabled
            className={`${navItem} w-full disabled:hover:bg-transparent`}
          >
            <IconChartHistogram aria-hidden="true" size={20} />
            Insights
          </button>
          <Link href="/projects" className={navItem}>
            <IconSettings aria-hidden="true" size={20} />
            Settings
          </Link>
        </div>
      </nav>
    </>
  );
}

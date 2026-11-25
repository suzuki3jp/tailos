import { IconMessages } from "@tabler/icons-react";
import { PageShell, sidebarItemClass } from "@/widgets/page-shell";
import {
  ProjectSessionContent,
  SessionProjectName,
} from "./project-session-content";
import { ProjectSessionsPanel } from "./project-sessions-panel";
import { SessionPanels } from "./session-panels";

type Props = { projectId: string; sessionId: string };

export function ProjectSessionPage({ projectId, sessionId }: Props) {
  return (
    <PageShell
      fixedHeight
      activePage="sessions"
      projectControl={
        <SessionProjectName projectId={projectId} sessionId={sessionId} />
      }
      sessionsNavigation={
        <SessionNavigation projectId={projectId} sessionId={sessionId} />
      }
    >
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
    </PageShell>
  );
}

function SessionNavigation({ projectId, sessionId }: Props) {
  return (
    <>
      <a
        href="#project-sessions"
        aria-current="page"
        className={`${sidebarItemClass} hidden lg:flex`}
      >
        <IconMessages aria-hidden="true" size={20} />
        Sessions
      </a>
      <details className="lg:hidden">
        <summary className={`${sidebarItemClass} cursor-pointer list-none`}>
          <IconMessages aria-hidden="true" size={20} />
          Sessions
        </summary>
        <ProjectSessionsPanel
          projectId={projectId}
          sessionId={sessionId}
          compact
        />
      </details>
    </>
  );
}

import { PageShell } from "@/widgets/page-shell";
import {
  ProjectSessionContent,
  SessionProjectName,
} from "./project-session-content";

type Props = { projectId: string; sessionId: string };

export function ProjectSessionPage({ projectId, sessionId }: Props) {
  return (
    <PageShell
      fixedHeight
      activePage="sessions"
      projectId={projectId}
      activeSessionId={sessionId}
      projectControl={
        <SessionProjectName projectId={projectId} sessionId={sessionId} />
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
    </PageShell>
  );
}

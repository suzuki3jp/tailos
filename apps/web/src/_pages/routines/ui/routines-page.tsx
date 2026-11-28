import { PageContent, PageShell } from "@/widgets/page-shell";
import { ProjectName } from "./project-name";
import { RoutineList } from "./routine-list";

export function RoutinesPage({ projectId }: { projectId: string }) {
  return (
    <PageShell
      activePage="routines"
      projectId={projectId}
      projectControl={<ProjectName projectId={projectId} />}
    >
      <PageContent centered>
        <div className="flex flex-col gap-6">
          <header>
            <h1 className="text-page-title font-semibold text-foreground">
              Routines
            </h1>
            <p className="text-body text-muted-foreground">
              Routines trigger agents from webhooks or crons
            </p>
          </header>
          <RoutineList projectId={projectId} />
        </div>
      </PageContent>
    </PageShell>
  );
}

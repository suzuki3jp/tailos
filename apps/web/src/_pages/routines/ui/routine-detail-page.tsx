import { PageContent, PageShell } from "@/widgets/page-shell";
import { ProjectName } from "./project-name";
import { RoutineDetail } from "./routine-detail";

export function RoutineDetailPage({
  projectId,
  routineId,
}: {
  projectId: string;
  routineId: string;
}) {
  return (
    <PageShell
      activePage="routines"
      projectId={projectId}
      projectControl={<ProjectName projectId={projectId} />}
    >
      <PageContent centered>
        <RoutineDetail projectId={projectId} routineId={routineId} />
      </PageContent>
    </PageShell>
  );
}

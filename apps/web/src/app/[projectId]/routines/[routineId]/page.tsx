import { headers } from "next/headers";
import { RoutineDetailPage } from "@/_pages/routines";
import { prefetchRoutines } from "@/_pages/routines/index.server";
import { QueryHydration } from "@/app/providers";

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string; routineId: string }>;
}) {
  const { projectId, routineId } = await params;
  const cookie = (await headers()).get("Cookie") ?? "";
  const state = await prefetchRoutines(cookie, projectId, routineId);
  return (
    <QueryHydration state={state}>
      <RoutineDetailPage projectId={projectId} routineId={routineId} />
    </QueryHydration>
  );
}

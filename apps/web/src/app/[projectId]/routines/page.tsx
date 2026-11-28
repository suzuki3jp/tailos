import { headers } from "next/headers";
import { RoutinesPage } from "@/_pages/routines";
import { prefetchRoutines } from "@/_pages/routines/index.server";
import { QueryHydration } from "@/app/providers";

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const cookie = (await headers()).get("Cookie") ?? "";
  const state = await prefetchRoutines(cookie, projectId);
  return (
    <QueryHydration state={state}>
      <RoutinesPage projectId={projectId} />
    </QueryHydration>
  );
}

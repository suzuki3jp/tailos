import { headers } from "next/headers";
import { ProjectSessionPage } from "@/_pages/session-detail";
import { prefetchProjectSession } from "@/_pages/session-detail/index.server";
import { QueryHydration } from "@/app/providers";

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  const cookie = (await headers()).get("Cookie") ?? "";
  const state = await prefetchProjectSession(cookie, projectId, sessionId);
  return (
    <QueryHydration state={state}>
      <ProjectSessionPage projectId={projectId} sessionId={sessionId} />
    </QueryHydration>
  );
}

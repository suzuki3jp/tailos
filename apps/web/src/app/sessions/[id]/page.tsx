import { SessionDetail } from "@/app/sessions/[id]/session-detail";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SessionDetail id={id} />;
}

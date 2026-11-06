export async function rescheduleDueRuns(
  listDueRunIds: (now: number) => Promise<string[]>,
  schedule: (runId: string) => Promise<void>,
) {
  const due = await listDueRunIds(Date.now());

  const results = await Promise.allSettled(due.map(schedule));
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Some due runs could not be scheduled");
  }
}

/** States of a stored Run, including time spent waiting for the Runner. */
export const activeRunStatuses = ["queued", "running"] as const;
export const runStatuses = [
  ...activeRunStatuses,
  "succeeded",
  "failed",
] as const;

export type RunStatus = (typeof runStatuses)[number];

export function isActiveRunStatus(
  status: string,
): status is (typeof activeRunStatuses)[number] {
  return activeRunStatuses.some((active) => active === status);
}

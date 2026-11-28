import {
  activeRunStatuses,
  runStatuses,
  type RunStatus,
} from "@tailos/core/run-status";

// Keep the values inline so SQLite can use the partial indexes for active runs.
function sqlList(statuses: readonly RunStatus[]) {
  return `(${statuses.map((status) => `'${status.replaceAll("'", "''")}'`).join(", ")})`;
}

export const activeRunStatusSql = sqlList(activeRunStatuses);
export const runStatusSql = sqlList(runStatuses);

import type { RunnerEvent } from "@tailos/core/runner";

export type TerminalResult =
  | { status: "succeeded" }
  | { status: "failed"; errorCode: string };
export type WriteRunArtifacts = (
  runId: string,
  completedAt: number,
  result: TerminalResult,
  events: readonly RunnerEvent[],
) => Promise<void>;

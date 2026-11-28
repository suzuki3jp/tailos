import { agentEngineLabels } from "@tailos/core/models";
import type { Routine } from "@/entities/routine";

/** The model and effort, falling back to the provider's defaults. */
export function modelLabel({
  engine,
  model,
  effort,
}: Pick<Routine, "engine" | "model" | "effort">) {
  return `${model ?? `${agentEngineLabels[engine]} default`} / ${effort ?? "default"}`;
}

const triggerEvents = {
  "github.issue-label": "labeled",
  "github.issue-comment": "commented",
} satisfies Record<Routine["trigger"]["type"], string>;

/** The GitHub event that starts the Routine, as in "Issue on Labeled". */
export function triggerEvent(trigger: Routine["trigger"]) {
  return triggerEvents[trigger.type];
}

/** What narrows the event: the label, or the comment command. */
export function triggerCondition(trigger: Routine["trigger"]) {
  return trigger.type === "github.issue-label"
    ? trigger.label
    : `@tailos ${trigger.command}`;
}

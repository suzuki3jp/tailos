import * as v from "valibot";
import { agentEngines, supportsSelection } from "@tailos/core/models";
import type { AgentConnected } from "@/application/auth/agent-connection.ts";
import { promptText } from "@tailos/core/runner";
import { allowedActors, projectName } from "@/application/projects/settings.ts";

export const implementationPrompt =
  "Implement the GitHub issue identified by the structured job context. Read the issue using tailos_github_get, make the required changes, and run relevant checks. Commit the changes on a new branch, push it, and open a pull request with gh whose body includes Closes #<issue number>. Summarize the result with the pull request URL.";
/**
 * The default implementation prompt from before the Agent opened pull
 * requests itself. Migration 0015 replaced it in Routines; a Session started
 * before then still carries it into its next Turns.
 */
export const legacyImplementationPrompt =
  "Implement the GitHub issue identified by the structured job context. Read the issue using tailos_github_get, make the required changes, run relevant checks, and summarize the result. Tailos handles publishing.";
/**
 * The default plan Routine prompt. Planning is only what the prompt asks:
 * the Turn runs with the same permissions as any other.
 */
export const planningPrompt =
  "Plan the GitHub issue identified by the structured job context, answering the new message from a permitted user. Read the issue using tailos_github_get and investigate the repository. Do not implement or publish changes. Reply with a concrete plan with assumptions, affected files, implementation steps and validation methods. Include questions if needed, then end this turn without waiting for answers; questions alone are a complete reply. Post your reply on the issue as a comment with gh issue comment, without mentioning anyone with @, and give the same reply in your answer.";
/**
 * The default plan Routine prompt from before planning ran in a read-only
 * mode whose instructions the Runner added. Migration 0016 replaced it in
 * Routines; a Session started before then still carries it into its next
 * Turns.
 */
export const legacyPlanningPrompt =
  "Plan the GitHub issue identified by the structured job context, answering the new message from a permitted user. Read the issue using tailos_github_get. Do not implement or publish changes. Post your reply on the issue as a comment with gh issue comment, without mentioning anyone with @, and give the same reply in your answer.";
const replacedPrompts = new Map([
  [legacyImplementationPrompt, implementationPrompt],
  [legacyPlanningPrompt, planningPrompt],
]);
/** A Turn's Routine instructions, with the old default prompts replaced. */
export const currentInstructions = (instructions: string | undefined) =>
  (instructions && replacedPrompts.get(instructions)) ?? instructions;
export const labelTrigger = v.strictObject({
  version: v.literal(1),
  type: v.literal("github.issue-label"),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
});
/**
 * `@tailos plan` on an issue. Only planning runs from comments for now; what
 * it does is up to its Routine's prompt.
 */
export const commentTrigger = v.strictObject({
  version: v.literal(1),
  type: v.literal("github.issue-comment"),
  command: v.literal("plan"),
});
const option = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.check((value) => !/[\p{Cc}\u2028\u2029]/u.test(value)),
);
export const routineSettings = v.strictObject({
  name: projectName,
  enabled: v.optional(v.boolean(), false),
  trigger: v.variant("type", [labelTrigger, commentTrigger]),
  allowedActors,
  prompt: promptText,
  engine: v.picklist(agentEngines),
  model: v.optional(option),
  effort: v.optional(option),
});
export const routine = v.strictObject({
  ...routineSettings.entries,
  id: v.pipe(v.string(), v.uuid()),
  projectId: v.pipe(v.string(), v.uuid()),
  revision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  deletedAt: v.nullable(v.number()),
});
export type RoutineSettings = v.InferOutput<typeof routineSettings>;
export type Routine = v.InferOutput<typeof routine>;
export type RoutineChange = {
  id: number;
  routineId: string;
  actorId: string;
  createdAt: number;
  before: RoutineSettings | null;
  after: RoutineSettings | null;
};
export type RoutineStore = {
  list(ownerId: string, projectId: string): Promise<Routine[] | null>;
  save(
    ownerId: string,
    projectId: string,
    settings: RoutineSettings,
    current?: { id: string; revision: number },
  ): Promise<Routine | null>;
  remove(
    ownerId: string,
    projectId: string,
    id: string,
    revision: number,
  ): Promise<boolean>;
  history(
    ownerId: string,
    projectId: string,
    before?: number,
  ): Promise<{ changes: RoutineChange[]; nextCursor: number | null } | null>;
  candidates(projectId: string): Promise<Routine[]>;
};
export async function validateRoutine(
  settings: RoutineSettings,
  connected: AgentConnected,
  ownerId: string,
) {
  const selection = supportsSelection(
    settings.engine,
    settings.model,
    settings.effort,
  );
  if (selection === "unsupported_model" || selection === "unsupported_effort")
    return selection;
  if (!settings.enabled) return null;
  // Without an explicit model, the provider may select any catalog default. A mixed
  // catalog cannot verify this combination; disabled saves still work.
  if (selection === "ambiguous_effort") return "configuration_unverified";
  return (await connected(ownerId, settings.engine).catch(() => false))
    ? null
    : "configuration_unverified";
}

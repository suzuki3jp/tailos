import * as v from "valibot";
import { promptText } from "@tailos/core/runner";
import { projectName, projectSchema } from "@/application/triggers/projects.ts";

export const implementationPrompt =
  "Implement the GitHub issue identified by the structured job context. Read the issue using tailos_github_get, make the required changes, run relevant checks, and summarize the result. Tailos handles publishing.";
const option = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.check((value) => !/[\p{Cc}\u2028\u2029]/u.test(value)),
);
export const routineSettings = v.strictObject({
  name: projectName,
  enabled: v.optional(v.boolean(), false),
  trigger: v.strictObject({
    version: v.literal(1),
    type: v.literal("github.issue-label"),
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
  }),
  allowedActors: projectSchema.entries.allowedActors,
  prompt: promptText,
  engine: v.literal("codex"),
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
export type CodexModel = { model: string; efforts: string[] };
export type ModelCatalog = (ownerId: string) => Promise<CodexModel[] | null>;
export async function validateRoutine(
  settings: RoutineSettings,
  catalog: ModelCatalog,
  ownerId: string,
) {
  const models = await catalog(ownerId).catch(() => null);
  if (!models?.length)
    return settings.enabled ? "configuration_unverified" : null;
  const candidates = settings.model
    ? models.filter((m) => m.model === settings.model)
    : models;
  if (!candidates.length) return "unsupported_model";
  if (settings.effort) {
    const effort = settings.effort;
    if (!candidates.some((m) => m.efforts.includes(effort)))
      return "unsupported_effort";
    // Without an explicit model, the provider may select any catalog default.
    // A mixed catalog cannot verify this combination; disabled saves still work.
    if (!settings.model && !candidates.every((m) => m.efforts.includes(effort)))
      return settings.enabled ? "configuration_unverified" : null;
  }
  return null;
}

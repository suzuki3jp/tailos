import * as v from "valibot";

const id = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const repository = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);
// Legacy imports retain their original configuration shape.
const configuration = v.strictObject({
  repository,
  repositoryId: id,
  installationId: id,
  allowedActors: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(100)),
  agentNetworkAccess: v.optional(v.boolean(), false),
  maxRunMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30)),
    30,
  ),
});
export const projectSchema = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  // Existing repository-based names may exceed the new input limit.
  name: v.pipe(v.string(), v.minLength(1)),
  ...configuration.entries,
});
const legacyProject = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/)),
  ...configuration.entries,
  triggerLabel: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
});
const uniqueProjects = (items: { id: string; repositoryId: number }[]) =>
  new Set(items.map((item) => item.repositoryId)).size === items.length &&
  new Set(items.map((item) => item.id)).size === items.length;
export const projectsSchema = v.pipe(
  v.array(projectSchema),
  v.maxLength(100),
  v.check((items) => uniqueProjects(items)),
);
export const legacyProjectsSchema = v.pipe(
  v.array(legacyProject),
  v.maxLength(100),
  v.check((items) => uniqueProjects(items)),
);
export const projectName = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
);
export const projectSettings = v.strictObject({
  name: projectName,
  ...configuration.entries,
});

export type Project = v.InferOutput<typeof projectSchema>;
export type ProjectSettings = v.InferOutput<typeof projectSettings>;

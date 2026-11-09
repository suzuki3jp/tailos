import * as v from "valibot";

const id = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const repository = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);
const project = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/)),
  repository,
  repositoryId: id,
  installationId: id,
  triggerLabel: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
  allowedActors: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(100)),
  maxRunMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30)),
    30,
  ),
});
export const projectsSchema = v.pipe(
  v.array(project),
  v.maxLength(100),
  v.check(
    (items) =>
      new Set(items.map((item) => item.repositoryId)).size === items.length &&
      new Set(items.map((item) => item.id)).size === items.length,
  ),
);

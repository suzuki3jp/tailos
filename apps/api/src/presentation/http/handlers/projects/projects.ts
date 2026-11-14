import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import {
  legacyProjectsSchema,
  projectSettings,
} from "@/application/triggers/projects.ts";
import {
  ProjectConflict,
  type ProjectRepositories,
  type ProjectStore,
} from "@/application/projects/store.ts";
import type { Bindings } from "@/bindings.ts";
import type {
  createOperatorAuth,
  OperatorEnv,
} from "@/presentation/http/middlewares/operator.ts";

const revision = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const update = v.strictObject({ ...projectSettings.entries, revision });
const remove = v.strictObject({ revision });
const projectId = v.pipe(v.string(), v.uuid());
function jsonInput<T extends v.GenericSchema>(schema: T) {
  return validator("json", (value: v.InferInput<T>, c) => {
    const parsed = v.safeParse(schema, value);
    return parsed.success
      ? parsed.output
      : c.json({ error: "invalid_input" as const }, 400);
  });
}
export function createProjectRoutes(
  store: (env: Bindings) => ProjectStore,
  repositories: (env: Bindings) => ProjectRepositories,
  auth: ReturnType<typeof createOperatorAuth>,
) {
  return new Hono<OperatorEnv>()
    .use("*", auth)
    .use("*", bodyLimit({ maxSize: 1024 * 1024 }))
    .onError((error, c) => {
      if (error instanceof HTTPException)
        return c.json({ error: "invalid_input" as const }, error.status);
      if (error instanceof ProjectConflict)
        return c.json({ error: "project_conflict" as const }, 409);
      // No GitHub response bodies, input settings or credentials in errors.
      return c.json({ error: "project_unavailable" as const }, 503);
    })
    .get("/", async (c) => c.json({ projects: await store(c.env).list() }))
    .get("/repositories", async (c) =>
      c.json({ repositories: await repositories(c.env).list() }),
    )
    .get("/history", async (c) => {
      const value = c.req.query("before");
      const cursor =
        value === undefined ? undefined : v.safeParse(revision, Number(value));
      if (cursor && !cursor.success)
        return c.json({ error: "invalid_input" as const }, 400);
      return c.json(await store(c.env).history(cursor?.output));
    })
    .post("/", jsonInput(projectSettings), async (c) => {
      const settings = c.req.valid("json");
      await repositories(c.env).verify(settings);
      return c.json(
        await store(c.env).create(settings, c.var.operatorUserId),
        201,
      );
    })
    .post("/import", jsonInput(legacyProjectsSchema), async (c) => {
      const legacy = c.req.valid("json");
      for (const project of legacy) await repositories(c.env).verify(project);
      const projects = legacy.map((project) => ({
        ...project,
        id: crypto.randomUUID(),
      }));
      await store(c.env).import(
        projects,
        legacy.map((p) => p.id),
        c.var.operatorUserId,
      );
      return c.json(
        {
          mapping: projects.map((project, i) => ({
            legacyId: legacy[i].id,
            id: project.id,
          })),
        },
        201,
      );
    })
    .post("/:id", jsonInput(update), async (c) => {
      const id = v.safeParse(projectId, c.req.param("id"));
      if (!id.success) return c.json({ error: "invalid_input" as const }, 400);
      const { revision, ...settings } = c.req.valid("json");
      await repositories(c.env).verify(settings);
      const result = await store(c.env).update(
        id.output,
        revision,
        settings,
        c.var.operatorUserId,
      );
      return result
        ? c.json(result)
        : c.json({ error: "project_conflict" as const }, 409);
    })
    .post("/:id/delete", jsonInput(remove), async (c) => {
      const id = v.safeParse(projectId, c.req.param("id"));
      if (!id.success) return c.json({ error: "invalid_input" as const }, 400);
      return (await store(c.env).remove(
        id.output,
        c.req.valid("json").revision,
        c.var.operatorUserId,
      ))
        ? c.json({ deleted: true as const })
        : c.json({ error: "project_conflict" as const }, 409);
    });
}

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import {
  decodePageCursor,
  encodePageCursor,
} from "@/application/pagination/cursor.ts";
import {
  legacyProjectsSchema,
  projectSettings,
} from "@/application/projects/settings.ts";
import {
  ProjectConflict,
  type ProjectRepositories,
  type ProjectStore,
} from "@/application/projects/store.ts";
import type { Bindings } from "@/bindings.ts";
import { jsonInput } from "@/presentation/http/middlewares/json-input.ts";
import type {
  createOperatorAuth,
  OperatorEnv,
} from "@/presentation/http/middlewares/operator.ts";

const revision = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const update = v.strictObject({ ...projectSettings.entries, revision });
const remove = v.strictObject({ revision });
const projectId = v.pipe(v.string(), v.uuid());
const positionSchema = v.strictObject({
  version: v.literal(1),
  name: v.string(),
  id: projectId,
});
const pageQuery = v.object({
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[1-9]\d*$/),
      v.transform(Number),
      v.safeInteger(),
      v.minValue(1),
      v.maxValue(100),
    ),
    "50",
  ),
  cursor: v.optional(v.string()),
});
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
      const errorName = [
        "Error",
        "TypeError",
        "SyntaxError",
        "ValiError",
        "GitHubRequestError",
      ].includes(error.name)
        ? error.name
        : "OtherError";
      // oxlint-disable-next-line no-console -- Static route and allowlisted error names only; never log exception messages or request bodies.
      console.warn("Project request failed", {
        method: c.req.method,
        route: c.req.routePath,
        errorName,
        githubConfigured: Boolean(
          c.env.TAILOS_GH_APP_ID && c.env.TAILOS_GH_APP_PRIVATE_KEY,
        ),
        ...c.get("diagnosticRequest"),
      });
      return c.json({ error: "project_unavailable" as const }, 503);
    })
    .get("/", async (c) => {
      const parsed = v.safeParse(pageQuery, c.req.query());
      if (!parsed.success)
        return c.json({ error: "invalid_input" as const }, 400);
      let after;
      try {
        after =
          parsed.output.cursor === undefined
            ? undefined
            : v.parse(positionSchema, decodePageCursor(parsed.output.cursor));
      } catch {
        return c.json({ error: "invalid_input" as const }, 400);
      }
      const page = await store(c.env).page(
        c.var.operatorUserId,
        parsed.output.limit,
        after,
      );
      return c.json({
        items: page.items,
        nextCursor: page.nextPosition
          ? encodePageCursor({ version: 1, ...page.nextPosition })
          : null,
      });
    })
    .get("/settings", async (c) =>
      c.json({ projects: await store(c.env).settings(c.var.operatorUserId) }),
    )
    .get("/repositories", async (c) =>
      c.json({ repositories: await repositories(c.env).list() }),
    )
    .get("/history", async (c) => {
      const value = c.req.query("before");
      const cursor =
        value === undefined ? undefined : v.safeParse(revision, Number(value));
      if (cursor && !cursor.success)
        return c.json({ error: "invalid_input" as const }, 400);
      return c.json(
        await store(c.env).history(c.var.operatorUserId, cursor?.output),
      );
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
        name: project.repository,
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

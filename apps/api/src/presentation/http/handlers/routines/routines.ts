import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import * as v from "valibot";
import {
  routineSettings,
  validateRoutine,
  type RoutineStore,
  type ModelCatalog,
} from "@/application/routines/routines.ts";
import type { Bindings } from "@/bindings.ts";
import type {
  createOperatorAuth,
  OperatorEnv,
} from "@/presentation/http/middlewares/operator.ts";
const uuid = v.pipe(v.string(), v.uuid());
const revision = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
function input<T extends v.GenericSchema>(schema: T) {
  return validator("json", (value: v.InferInput<T>, c) => {
    const parsed = v.safeParse(schema, value);
    return parsed.success
      ? parsed.output
      : c.json({ error: "invalid_input" as const }, 400);
  });
}
export function createRoutineRoutes(
  store: (env: Bindings) => RoutineStore,
  catalog: (env: Bindings) => ModelCatalog,
  auth: ReturnType<typeof createOperatorAuth>,
) {
  return new Hono<OperatorEnv>()
    .use("*", auth)
    .use("*", bodyLimit({ maxSize: 32 * 1024 }))
    .use("*", async (c, next) => {
      if (!v.safeParse(uuid, c.req.param("projectId")).success)
        return c.json({ error: "invalid_input" as const }, 400);
      await next();
    })
    .onError((error, c) => {
      if (error instanceof HTTPException)
        return c.json({ error: "invalid_input" as const }, error.status);
      return c.json({ error: "routine_unavailable" as const }, 503);
    })
    .get("/", async (c) => {
      const routines = await store(c.env).list(
        c.var.operatorUserId,
        c.req.param("projectId")!,
      );
      return routines
        ? c.json({ routines })
        : c.json({ error: "not_found" as const }, 404);
    })
    .get("/models", async (c) => {
      const ownerId = c.var.operatorUserId;
      if (!(await store(c.env).list(ownerId, c.req.param("projectId")!)))
        return c.json({ error: "not_found" as const }, 404);
      const models = await catalog(c.env)(ownerId);
      return models?.length
        ? c.json({ models })
        : c.json({ error: "configuration_unverified" as const }, 503);
    })
    .get(
      "/history",
      validator("query", (value, c) => {
        const parsed = v.safeParse(
          v.object({
            before: v.optional(v.pipe(v.string(), v.regex(/^[1-9]\d*$/))),
          }),
          value,
        );
        return parsed.success
          ? parsed.output
          : c.json({ error: "invalid_input" as const }, 400);
      }),
      async (c) => {
        const before = c.req.query("before");
        if (
          before !== undefined &&
          !v.safeParse(revision, Number(before)).success
        )
          return c.json({ error: "invalid_input" as const }, 400);
        const result = await store(c.env).history(
          c.var.operatorUserId,
          c.req.param("projectId")!,
          before === undefined ? undefined : Number(before),
        );
        return result
          ? c.json(result)
          : c.json({ error: "not_found" as const }, 404);
      },
    )
    .post("/", input(routineSettings), async (c) => {
      const settings = c.req.valid("json");
      if (
        !(await store(c.env).list(
          c.var.operatorUserId,
          c.req.param("projectId")!,
        ))
      )
        return c.json({ error: "not_found" as const }, 404);
      const error = await validateRoutine(
        settings,
        catalog(c.env),
        c.var.operatorUserId,
      );
      if (error)
        return c.json(
          { error },
          error === "configuration_unverified" ? 503 : 400,
        );
      const result = await store(c.env).save(
        c.var.operatorUserId,
        c.req.param("projectId")!,
        settings,
      );
      return result
        ? c.json(result, 201)
        : c.json({ error: "routine_conflict" as const }, 409);
    })
    .post(
      "/:id",
      input(v.strictObject({ ...routineSettings.entries, revision })),
      async (c) => {
        const { revision, ...settings } = c.req.valid("json");
        if (!v.safeParse(uuid, c.req.param("id")).success)
          return c.json({ error: "invalid_input" as const }, 400);
        if (
          !(await store(c.env).list(
            c.var.operatorUserId,
            c.req.param("projectId")!,
          ))
        )
          return c.json({ error: "not_found" as const }, 404);
        const error = await validateRoutine(
          settings,
          catalog(c.env),
          c.var.operatorUserId,
        );
        if (error)
          return c.json(
            { error },
            error === "configuration_unverified" ? 503 : 400,
          );
        const result = await store(c.env).save(
          c.var.operatorUserId,
          c.req.param("projectId")!,
          settings,
          { id: c.req.param("id"), revision },
        );
        return result
          ? c.json(result)
          : c.json({ error: "routine_conflict" as const }, 409);
      },
    )
    .post("/:id/delete", input(v.strictObject({ revision })), async (c) => {
      if (!v.safeParse(uuid, c.req.param("id")).success)
        return c.json({ error: "invalid_input" as const }, 400);
      const removed = await store(c.env).remove(
        c.var.operatorUserId,
        c.req.param("projectId")!,
        c.req.param("id"),
        c.req.valid("json").revision,
      );
      return removed
        ? c.json({ deleted: true as const })
        : c.json({ error: "routine_conflict" as const }, 409);
    });
}

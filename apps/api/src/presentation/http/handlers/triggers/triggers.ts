import type { AdmitTrigger } from "#api/application/triggers/admit-trigger.ts";
import { codexConnectionId } from "#api/application/auth/device.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import {
  smokeAuth,
  smokeOwnerId,
} from "#api/presentation/http/middlewares/smoke-auth.ts";
import { type Bindings } from "#api/bindings.ts";

const identifier = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(128),
);
const triggerInput = v.strictObject({
  deliveryId: identifier,
  target: identifier,
  engine: v.optional(v.picklist(["fake", "codex"]), "fake"),
  prompt: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
});

export function createTriggerRoutes(
  scheduleRun: (env: Bindings) => ((id: string) => Promise<void>) | undefined,
  admit: (env: Bindings) => AdmitTrigger,
  findOperatorUserId: (env: Bindings) => Promise<string | null>,
) {
  const triggerRoutes = new Hono<{ Bindings: Bindings }>();
  triggerRoutes.use("*", smokeAuth);
  triggerRoutes.post("/", bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = v.safeParse(triggerInput, body);
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const { deliveryId, target, prompt, engine } = parsed.output;
    const operatorId =
      engine === "codex" ? await findOperatorUserId(c.env) : null;
    if (engine === "codex" && !operatorId)
      return c.json({ error: "operator_not_initialized" }, 503);

    const connectionId = operatorId ? codexConnectionId(operatorId) : null;
    const admission = await admit(c.env)({
      source: "internal.smoke",
      idempotencyKey: deliveryId,
      ownerId: smokeOwnerId,
      target: JSON.stringify({ version: 1, kind: "smoke", target }),
      concurrencyKey: JSON.stringify(
        connectionId
          ? ["internal.smoke", target, engine, connectionId]
          : ["internal.smoke", target],
      ),
      prompt,
      executionContext: JSON.stringify(
        connectionId
          ? { version: 1, engine, connectionId }
          : { version: 1, engine },
      ),
      timeoutMs: 5 * 60_000,
    });
    if (admission.disposition === "started") {
      await scheduleRun(c.env)?.(admission.runId).catch(() => {
        // The committed D1 row remains due for the scheduled recovery sweep.
      });
    }
    return c.json(admission);
  });

  return triggerRoutes;
}

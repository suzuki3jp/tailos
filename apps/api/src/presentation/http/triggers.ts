import type { AdmitTrigger } from "../../application/triggers/admit-trigger.ts";
import { codexConnectionId } from "../../application/auth/device.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { smokeAuth, smokeOwnerId } from "./smoke-auth.ts";
import { type Bindings } from "../../bindings.ts";

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

    const admission = await admit(c.env)({
      source: "internal.smoke",
      idempotencyKey: deliveryId,
      ownerId: smokeOwnerId,
      target: JSON.stringify({ version: 1, kind: "smoke", target }),
      concurrencyKey: JSON.stringify(["internal.smoke", target]),
      prompt,
      executionContext: JSON.stringify(
        operatorId
          ? { version: 1, engine, connectionId: codexConnectionId(operatorId) }
          : { version: 1, engine },
      ),
      timeoutMs: 5 * 60_000,
    });
    if (admission.disposition === "started" && c.env.RUNNER) {
      await c.env.RUNNER.getByName(admission.runId)
        .schedule(admission.runId)
        .catch(() => {
          // The committed D1 row remains due for the scheduled recovery sweep.
        });
    }
    return c.json(admission);
  });

  return triggerRoutes;
}

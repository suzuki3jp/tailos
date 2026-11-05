import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { smokeAuth, smokeOwnerId, type Bindings } from "./internal.ts";
import { admitTrigger } from "./trigger-admission.ts";

const identifier = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(128),
);
const triggerInput = v.strictObject({
  deliveryId: identifier,
  target: identifier,
  prompt: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
});

export const triggerRoutes = new Hono<{ Bindings: Bindings }>();
triggerRoutes.use("*", smokeAuth);
triggerRoutes.post("/", bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = v.safeParse(triggerInput, body);
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

  const { deliveryId, target, prompt } = parsed.output;
  const admission = await admitTrigger(c.env.DB, {
    source: "internal.smoke",
    idempotencyKey: deliveryId,
    ownerId: smokeOwnerId,
    target: JSON.stringify({ version: 1, kind: "smoke", target }),
    concurrencyKey: JSON.stringify(["internal.smoke", target]),
    prompt,
    executionContext: JSON.stringify({ version: 1, engine: "fake" }),
    timeoutMs: 60_000,
  });
  return c.json(admission);
});

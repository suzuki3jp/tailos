import { validator } from "hono/validator";
import * as v from "valibot";

export function jsonInput<T extends v.GenericSchema>(schema: T) {
  return validator("json", (value: v.InferInput<T>, c) => {
    const parsed = v.safeParse(schema, value);
    return parsed.success
      ? parsed.output
      : c.json({ error: "invalid_input" as const }, 400);
  });
}

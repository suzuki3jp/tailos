import * as v from "valibot";

const configSchema = v.strictObject({
  version: v.literal(1),
  ownerId: v.pipe(v.string(), v.uuid()),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

export function parseMcpKeyConfig(value: string | undefined) {
  try {
    const parsed = v.safeParse(configSchema, JSON.parse(value ?? "null"));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

export type McpAuthentication =
  | { state: "disabled" }
  | { state: "unauthorized" }
  | { state: "authenticated"; ownerId: string };

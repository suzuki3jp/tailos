export type ModelEffort = { model?: string; effort?: string };

export const defaultModelEffort = "default";

/** Encodes a model and effort as one select value. */
export function modelEffortValue(model: string, effort?: string) {
  return JSON.stringify([model, effort ?? null]);
}

/** Decodes a select value; the default leaves both to the provider. */
export function parseModelEffort(value: string): ModelEffort {
  if (value === defaultModelEffort) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      (parsed[1] === null || typeof parsed[1] === "string")
    )
      return parsed[1] === null
        ? { model: parsed[0] }
        : { model: parsed[0], effort: parsed[1] };
  } catch {
    // Unknown values fall back to the provider default.
  }
  return {};
}

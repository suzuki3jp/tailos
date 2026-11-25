import { agentEngines, type AgentEngine } from "@tailos/core/models";

export type ModelEffort = {
  engine?: AgentEngine;
  model?: string;
  effort?: string;
};

/** Leaves the Model Provider, model and effort to their defaults. */
export const defaultModelEffort = "default";

/**
 * Encodes a Model Provider, model and effort as one select value. Without a
 * model the provider picks its default.
 */
export function modelEffortValue(
  engine: AgentEngine,
  model?: string,
  effort?: string,
) {
  return JSON.stringify([engine, model ?? null, effort ?? null]);
}

const isEngine = (value: unknown): value is AgentEngine =>
  (agentEngines as readonly unknown[]).includes(value);
const optional = (value: unknown) =>
  value === null || typeof value === "string";

/** Decodes a select value; the default leaves everything to the provider. */
export function parseModelEffort(value: string): ModelEffort {
  if (value === defaultModelEffort) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      isEngine(parsed[0]) &&
      optional(parsed[1]) &&
      optional(parsed[2])
    ) {
      const [engine, model, effort] = parsed as [
        AgentEngine,
        string | null,
        string | null,
      ];
      return {
        engine,
        ...(model !== null && { model }),
        ...(model !== null && effort !== null && { effort }),
      };
    }
  } catch {
    // Unknown values fall back to the provider default.
  }
  return {};
}

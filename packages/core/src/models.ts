export type AgentModel = {
  readonly model: string;
  readonly efforts: readonly string[];
};

/** The Model Providers a Turn can run on. */
export const agentEngines = ["codex", "claude"] as const;
export type AgentEngine = (typeof agentEngines)[number];

/**
 * Codex CLI version whose bundled catalog `codexModels` mirrors. A Runner test
 * keeps it equal to `TAILOS_CODEX_VERSION` in the Runner Dockerfile.
 */
export const codexCatalogVersion = "0.166.0";

const gpt6Efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const lunaEfforts = ["low", "medium", "high", "xhigh", "max"];

/**
 * Codex models and reasoning efforts Tailos offers.
 *
 * Mirrors the models listed (visibility "list") in the catalog bundled with
 * Codex CLI `codexCatalogVersion`, in its priority order. Update this list and
 * the version together when the Runner's Codex CLI changes.
 */
export const codexModels: readonly AgentModel[] = [
  { model: "gpt-6.1-sol", efforts: gpt6Efforts },
  { model: "gpt-6-astra", efforts: gpt6Efforts },
  { model: "gpt-6-sol", efforts: gpt6Efforts },
  { model: "gpt-6-luna", efforts: lunaEfforts },
  { model: "gpt-5.6-sol", efforts: gpt6Efforts },
  { model: "gpt-6.1-terra", efforts: gpt6Efforts },
  { model: "gpt-5.6-terra", efforts: gpt6Efforts },
  { model: "gpt-5.6-luna", efforts: lunaEfforts },
  { model: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
];

/**
 * Agent SDK version whose bundled Claude Code `claudeModels` mirrors. A Runner
 * test keeps it equal to `TAILOS_CLAUDE_AGENT_SDK_VERSION` in the Runner
 * Dockerfile.
 */
export const claudeCatalogVersion = "0.3.319";

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];

/**
 * Claude models and efforts Tailos offers.
 *
 * Mirrors the models that the Claude Code bundled with Agent SDK
 * `claudeCatalogVersion` offers (`supportedModels()`), by the model each of
 * its aliases resolves to, in its order, with every effort level each one
 * supports. Update this list and the version together when the Runner's
 * Agent SDK changes.
 */
export const claudeModels: readonly AgentModel[] = [
  { model: "claude-sonnet-5-5", efforts: claudeEfforts },
  { model: "claude-fable-5-1", efforts: claudeEfforts },
  { model: "claude-opus-5-5", efforts: claudeEfforts },
  { model: "claude-haiku-5-5", efforts: claudeEfforts },
];

/** The models and efforts Tailos offers for a Model Provider. */
export function agentModels(engine: AgentEngine): readonly AgentModel[] {
  return engine === "claude" ? claudeModels : codexModels;
}

/** The name people see for a Model Provider. */
export const agentEngineLabels: Record<AgentEngine, string> = {
  codex: "Codex",
  claude: "Claude",
};

/**
 * Whether the Model Provider can run the model and effort. Without a model,
 * the provider picks its default, so the effort must be available on every
 * model.
 */
export function supportsSelection(
  engine: AgentEngine,
  model?: string,
  effort?: string,
) {
  const catalog = agentModels(engine);
  const candidates = model
    ? catalog.filter((item) => item.model === model)
    : catalog;
  if (!candidates.length) return "unsupported_model" as const;
  if (!effort) return null;
  if (!candidates.some((item) => item.efforts.includes(effort)))
    return "unsupported_effort" as const;
  return candidates.every((item) => item.efforts.includes(effort))
    ? null
    : ("ambiguous_effort" as const);
}

/** Whether Codex can run the model and effort. */
export function supportsCodexSelection(model?: string, effort?: string) {
  return supportsSelection("codex", model, effort);
}

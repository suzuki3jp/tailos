export type AgentModel = {
  readonly model: string;
  readonly efforts: readonly string[];
};

const gpt6Efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const lunaEfforts = ["low", "medium", "high", "xhigh", "max"];

/**
 * Codex models and reasoning efforts Tailos offers.
 *
 * Mirrors the models listed (visibility "list") in the catalog bundled with
 * the Codex CLI the Runner installs (`TAILOS_CODEX_VERSION`), in its priority
 * order. Update this list when that version changes.
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
 * Whether Codex can run the model and effort. Without a model, Codex picks its
 * default, so the effort must be available on every model.
 */
export function supportsCodexSelection(model?: string, effort?: string) {
  const candidates = model
    ? codexModels.filter((item) => item.model === model)
    : codexModels;
  if (!candidates.length) return "unsupported_model" as const;
  if (!effort) return null;
  if (!candidates.some((item) => item.efforts.includes(effort)))
    return "unsupported_effort" as const;
  return candidates.every((item) => item.efforts.includes(effort))
    ? null
    : ("ambiguous_effort" as const);
}

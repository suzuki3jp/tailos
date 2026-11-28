import {
  agentEngineLabels,
  agentEngines,
  agentModels,
  type AgentEngine,
} from "@tailos/core/models";
import { Select, type SelectGroup } from "@/shared/ui/design-systems";
import { defaultModelEffort, modelEffortValue } from "../model/model-effort";

const effortLabels: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/** The choices of one Model Provider: its default, then each model. */
function providerGroups(engine: AgentEngine): SelectGroup[] {
  const provider = agentEngineLabels[engine];
  return [
    {
      id: engine,
      label: provider,
      options: [
        {
          id: modelEffortValue(engine),
          label: `${provider} / Default model`,
        },
      ],
    },
    ...agentModels(engine).map(({ model, efforts }) => ({
      id: `${engine}/${model}`,
      label: `${provider} · ${model}`,
      options: [undefined, ...efforts].map((effort) => ({
        id: modelEffortValue(engine, model, effort),
        label: `${model} / ${effort ? (effortLabels[effort] ?? effort) : "Default effort"}`,
      })),
    })),
  ];
}

/**
 * Chooses the Model Provider, model and effort. With `engine`, only that
 * provider's models are offered: a Session keeps its provider.
 */
export function ModelEffortSelect({
  value,
  onValueChange,
  disabled,
  engine,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  engine?: AgentEngine;
}) {
  const defaultOption = {
    id: defaultModelEffort,
    label: engine
      ? `${agentEngineLabels[engine]} / Default model / effort`
      : "Default model / effort",
  };
  const groups = (engine ? [engine] : agentEngines).flatMap(providerGroups);
  return (
    <Select
      aria-label="Model provider, model and effort"
      options={[defaultOption, ...groups]}
      {...(value === undefined
        ? { defaultValue: defaultOption.id }
        : { value })}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(next);
      }}
      disabled={disabled}
      variant="ghost"
      size="xs"
      className="max-w-48"
      placement="top end"
      popoverClassName="min-w-64 max-w-[calc(100vw-2rem)]"
    />
  );
}

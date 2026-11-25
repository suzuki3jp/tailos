import {
  agentEngineLabels,
  agentEngines,
  agentModels,
  type AgentEngine,
} from "@tailos/core/models";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
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

type Option = { value: string; label: string };
type Group = { key: string; label: string; options: Option[] };

/** The choices of one Model Provider: its default, then each model. */
function providerGroups(engine: AgentEngine): Group[] {
  const provider = agentEngineLabels[engine];
  return [
    {
      key: engine,
      label: provider,
      options: [
        {
          value: modelEffortValue(engine),
          label: `${provider} / Default model`,
        },
      ],
    },
    ...agentModels(engine).map(({ model, efforts }) => ({
      key: `${engine}/${model}`,
      label: `${provider} · ${model}`,
      options: [undefined, ...efforts].map((effort) => ({
        value: modelEffortValue(engine, model, effort),
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
    value: defaultModelEffort,
    label: engine
      ? `${agentEngineLabels[engine]} / Default model / effort`
      : "Default model / effort",
  };
  const groups = (engine ? [engine] : agentEngines).flatMap(providerGroups);
  const items = [defaultOption, ...groups.flatMap(({ options }) => options)];
  return (
    <Select
      items={items}
      {...(value === undefined
        ? { defaultValue: defaultOption.value }
        : { value })}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange?.(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label="Model provider, model and effort"
        variant="ghost"
        size="xs"
        className="min-w-0 max-w-48"
      >
        <SelectValue className="truncate" />
      </SelectTrigger>
      <SelectContent
        side="top"
        align="end"
        alignItemWithTrigger={false}
        className="min-w-64 max-w-[calc(100vw-2rem)]"
      >
        <SelectItem value={defaultOption.value}>
          {defaultOption.label}
        </SelectItem>
        {groups.map(({ key, label, options }) => (
          <SelectGroup key={key}>
            <SelectLabel>{label}</SelectLabel>
            {options.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

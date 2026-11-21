import { codexModels } from "@tailos/core/models";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

const defaultOption = { value: "default", label: "Default model / effort" };
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
const groups = codexModels.map(({ model, efforts }) => ({
  model,
  options: [undefined, ...efforts].map((effort) => ({
    value: JSON.stringify([model, effort]),
    label: `${model} / ${effort ? (effortLabels[effort] ?? effort) : "Default effort"}`,
  })),
}));
const items = [defaultOption, ...groups.flatMap(({ options }) => options)];

export function ModelEffortSelect() {
  return (
    <Select items={items} defaultValue={defaultOption.value}>
      <SelectTrigger
        aria-label="Model and effort"
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
        {groups.map(({ model, options }) => (
          <SelectGroup key={model}>
            <SelectLabel>{model}</SelectLabel>
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

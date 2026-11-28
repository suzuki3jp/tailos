import type { SelectableProject } from "../api/queries";

export type ProjectSelection = {
  projects: SelectableProject[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled: boolean;
};

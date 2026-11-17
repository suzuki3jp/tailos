import type { HomeProject } from "../api/queries";

export type ProjectSelection = {
  projects: HomeProject[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled: boolean;
};

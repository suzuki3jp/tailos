"use client";

import { useProjectSelection } from "@/features/select-project";
import { SidebarRoutinesLink } from "./sidebar-routines-link";

/** Links to the Routines of the Project chosen in the sidebar. */
export function SelectedProjectRoutinesLink({ active }: { active: boolean }) {
  const { selection } = useProjectSelection();
  return <SidebarRoutinesLink projectId={selection.value} active={active} />;
}

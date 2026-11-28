import Link from "next/link";
import { IconRepeat } from "@tabler/icons-react";
import { Button } from "@/shared/ui/design-systems";
import { cn } from "@/shared/lib/cn";
import { routinesPath } from "@/shared/lib/routine-path";
import { sidebarItemClass } from "./sidebar-item";

/** Routines belong to a Project, so the item waits for one. */
export function SidebarRoutinesLink({
  projectId,
  active,
}: {
  projectId?: string | null;
  active: boolean;
}) {
  const content = (
    <>
      <IconRepeat aria-hidden="true" size={20} />
      Routines
    </>
  );
  if (!projectId)
    return (
      <Button
        unstyled
        type="button"
        isDisabled
        title="Select a project to see its routines"
        className={cn(
          sidebarItemClass,
          "disabled:cursor-default disabled:hover:bg-transparent",
        )}
      >
        {content}
      </Button>
    );
  return (
    <Link
      href={routinesPath(projectId)}
      aria-current={active ? "page" : undefined}
      className={sidebarItemClass}
    >
      {content}
    </Link>
  );
}

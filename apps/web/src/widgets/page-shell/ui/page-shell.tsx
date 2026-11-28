import { Button } from "@/shared/ui/design-systems";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  IconHome,
  IconMessages,
  IconChartHistogram,
  IconSettings,
} from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { MobileNavigation } from "@/shared/ui/mobile-navigation";
import {
  CurrentProjectSelect,
  ProjectSelectionProvider,
} from "@/features/select-project";
import { SidebarAccount } from "./sidebar-account";
import { SidebarRecentSessions } from "./sidebar-recent-sessions";
import { sidebarItemClass } from "./sidebar-item";
import { SidebarRoutinesLink } from "./sidebar-routines-link";
import { SelectedProjectRoutinesLink } from "./selected-project-routines-link";

type Props = {
  children: ReactNode;
  projectControl: ReactNode;
  sessionsHref?: string;
  activePage?: "home" | "sessions" | "routines" | "settings";
  /** The Project the page belongs to, whose Routines the sidebar links to. */
  projectId?: string;
  /** The Session shown on the page, highlighted in Recent Sessions. */
  activeSessionId?: string;
  fixedHeight?: boolean;
};

type SidebarProps = Omit<Props, "children" | "projectId"> & {
  routinesLink: ReactNode;
};

function Sidebar({
  projectControl,
  sessionsHref = "/#recent-sessions",
  activePage,
  activeSessionId,
  routinesLink,
}: SidebarProps) {
  return (
    <>
      <div className="flex h-15 shrink-0 items-center gap-2.5 px-3">
        <Link href="/" aria-label="Tailos home" className="shrink-0 rounded-md">
          <img
            src="/assets/design-system/tailos-symbol.png"
            alt=""
            width={48}
            height={48}
          />
        </Link>
        {projectControl}
      </div>
      <nav aria-label="Main navigation" className="flex flex-col gap-6">
        <Link
          href="/"
          aria-current={activePage === "home" ? "page" : undefined}
          className={sidebarItemClass}
        >
          <IconHome aria-hidden="true" size={20} />
          Account Home
        </Link>
        <div>
          <Link
            href={sessionsHref}
            aria-current={activePage === "sessions" ? "page" : undefined}
            className={sidebarItemClass}
          >
            <IconMessages aria-hidden="true" size={20} />
            Sessions
          </Link>
          {routinesLink}
          <Button
            unstyled
            type="button"
            isDisabled
            title="Insights is not available"
            className={cn(
              sidebarItemClass,
              "disabled:cursor-default disabled:hover:bg-transparent",
            )}
          >
            <IconChartHistogram aria-hidden="true" size={20} />
            Insights
          </Button>
          <Link
            href="/projects"
            aria-current={activePage === "settings" ? "page" : undefined}
            className={sidebarItemClass}
          >
            <IconSettings aria-hidden="true" size={20} />
            Settings
          </Link>
        </div>
      </nav>
      <SidebarRecentSessions activeSessionId={activeSessionId} />
      <SidebarAccount />
    </>
  );
}

export function PageShell({
  children,
  fixedHeight = false,
  projectId,
  routinesLink,
  ...props
}: Props & { routinesLink?: ReactNode }) {
  const navigation = {
    ...props,
    routinesLink: routinesLink ?? (
      <SidebarRoutinesLink
        projectId={projectId}
        active={props.activePage === "routines"}
      />
    ),
  };
  return (
    <div
      className={cn(
        "flex bg-background text-foreground",
        fixedHeight ? "h-dvh min-h-0" : "min-h-dvh",
      )}
      lang="en"
    >
      {/* oxlint-disable-next-line tailos-web/boundaries -- Use native fragment navigation to move keyboard focus to the content. */}
      <a
        href="#page-content"
        className="sr-only z-50 rounded-md bg-background p-3 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <aside
        aria-label="Project sidebar"
        className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex"
      >
        <Sidebar {...navigation} />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-15 shrink-0 items-center border-b px-3 md:hidden">
          <MobileNavigation>
            <Sidebar {...navigation} />
          </MobileNavigation>
        </div>
        <div
          id="page-content"
          tabIndex={-1}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function ProjectPageShell(props: Omit<Props, "projectControl">) {
  return (
    <ProjectSelectionProvider>
      <PageShell
        {...props}
        projectControl={<CurrentProjectSelect />}
        routinesLink={
          <SelectedProjectRoutinesLink
            active={props.activePage === "routines"}
          />
        }
      />
    </ProjectSelectionProvider>
  );
}

export function PageContent({
  children,
  slot,
  home = false,
  centered = home,
}: {
  children: ReactNode;
  slot?: ReactNode;
  home?: boolean;
  /** Center the content in the whole area, without room for a right slot. */
  centered?: boolean;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 justify-center">
        <main
          className={cn(
            "flex w-full max-w-172 flex-col gap-15 px-6 pb-12",
            home ? "pt-12 md:pt-18" : "pt-12",
          )}
        >
          {children}
        </main>
      </div>
      {!centered && <div className="hidden w-60 shrink-0 xl:block">{slot}</div>}
    </div>
  );
}

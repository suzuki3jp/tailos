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

export const sidebarItemClass =
  "flex h-9 w-full items-center gap-3 px-6 py-2.5 text-caption hover:bg-sidebar-accent [&_svg]:shrink-0 [&_svg]:text-foreground-strong";

type Props = {
  children: ReactNode;
  projectControl: ReactNode;
  sessionsNavigation?: ReactNode;
  sessionsHref?: string;
  activePage?: "home" | "sessions" | "settings";
  fixedHeight?: boolean;
};

function Sidebar({
  projectControl,
  sessionsNavigation,
  sessionsHref = "/#recent-sessions",
  activePage,
}: Omit<Props, "children">) {
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
          {sessionsNavigation ?? (
            <Link
              href={sessionsHref}
              aria-current={activePage === "sessions" ? "page" : undefined}
              className={sidebarItemClass}
            >
              <IconMessages aria-hidden="true" size={20} />
              Sessions
            </Link>
          )}
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
      <SidebarAccount />
    </>
  );
}

export function PageShell({
  children,
  fixedHeight = false,
  ...navigation
}: Props) {
  return (
    <div
      className={cn(
        "flex bg-background text-foreground",
        fixedHeight ? "h-dvh min-h-0" : "min-h-dvh",
      )}
      lang="en"
    >
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
        <div id="page-content" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}

export function ProjectPageShell(props: Omit<Props, "projectControl">) {
  return (
    <ProjectSelectionProvider>
      <PageShell {...props} projectControl={<CurrentProjectSelect />} />
    </ProjectSelectionProvider>
  );
}

export function PageContent({
  children,
  slot,
  home = false,
}: {
  children: ReactNode;
  slot?: ReactNode;
  home?: boolean;
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
      {!home && <div className="hidden w-60 shrink-0 xl:block">{slot}</div>}
    </div>
  );
}

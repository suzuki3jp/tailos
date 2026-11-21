import Link from "next/link";
import { IconUser } from "@tabler/icons-react";
import { HomeSidebar } from "./home-sidebar";
import { HomeComposer } from "./home-composer";
import { RecentSessions } from "./recent-sessions";
import { ProjectSelectionProvider } from "./project-selection";
import { ProjectStatus } from "./project-status";
import { MobileNavigation } from "@/shared/ui/mobile-navigation";

export function HomePage() {
  return (
    <ProjectSelectionProvider>
      <div
        className="flex min-h-dvh bg-background text-foreground"
        data-home
        lang="en"
      >
        <a
          href="#home-content"
          className="sr-only z-50 rounded-md bg-background p-3 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <aside
          aria-label="Project sidebar"
          className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex"
        >
          <HomeSidebar />
        </aside>
        <div className="min-w-0 flex-1">
          <header className="flex h-15 items-center justify-between border-b px-3 md:justify-end">
            <MobileNavigation>
              <HomeSidebar />
            </MobileNavigation>
            <Link
              href="/login"
              aria-label="Open account"
              className="rounded-full"
            >
              <span className="flex size-9 items-center justify-center rounded-full bg-muted">
                <IconUser aria-hidden="true" size={20} />
              </span>
            </Link>
          </header>
          <main
            id="home-content"
            className="mx-auto flex w-full max-w-172 flex-col gap-15 px-6 pt-12 pb-12"
            aria-label="Home"
          >
            <section aria-labelledby="home-heading" className="space-y-3">
              <h1
                id="home-heading"
                className="text-page-title font-semibold text-foreground-strong"
              >
                Let’s dive into the looooop!
              </h1>
              <ProjectStatus />
              <HomeComposer />
            </section>
            <RecentSessions />
          </main>
        </div>
      </div>
    </ProjectSelectionProvider>
  );
}

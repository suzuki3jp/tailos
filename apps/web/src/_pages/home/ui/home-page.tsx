import { HomeComposer } from "./home-composer";
import { RecentSessions } from "./recent-sessions";
import { ProjectStatus } from "./project-status";
import { ProjectPageShell, PageContent } from "@/widgets/page-shell";
import { HomeGreeting } from "./home-greeting";

export function HomePage() {
  return (
    <ProjectPageShell sessionsHref="#recent-sessions" activePage="home">
      <PageContent home>
        <section aria-labelledby="home-heading" className="space-y-3">
          <h1
            id="home-heading"
            className="text-page-title font-semibold text-foreground-strong"
          >
            Let’s dive into the looooop
            <HomeGreeting />!
          </h1>
          <ProjectStatus />
          <HomeComposer />
        </section>
        <RecentSessions />
      </PageContent>
    </ProjectPageShell>
  );
}

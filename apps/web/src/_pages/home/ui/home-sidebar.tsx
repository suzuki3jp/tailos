import Link from "next/link";
import {
  IconHome,
  IconMessages,
  IconChartHistogram,
  IconSettings,
} from "@tabler/icons-react";
import { ProjectSelect, type ProjectSelection } from "./project-select";

const itemClass =
  "flex h-12 w-full items-center gap-6 px-6 py-2.5 text-caption hover:bg-sidebar-accent";

export function HomeSidebar({
  onNavigate,
  projectSelection,
}: {
  onNavigate?: () => void;
  projectSelection: ProjectSelection;
}) {
  return (
    <>
      <div className="flex h-15 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-3">
        <Link
          href="/"
          aria-label="Tailos home"
          onClick={onNavigate}
          className="shrink-0 rounded-md"
        >
          <img
            src="/assets/design-system/tailos-symbol.png"
            alt=""
            width={48}
            height={48}
          />
        </Link>
        <ProjectSelect {...projectSelection} />
      </div>
      <nav aria-label="Main navigation" className="flex flex-col gap-9">
        <Link
          href="/"
          aria-current="page"
          className={itemClass}
          onClick={onNavigate}
        >
          <IconHome
            aria-hidden="true"
            size={20}
            className="shrink-0 text-foreground-strong"
          />
          Account Home
        </Link>
        <div>
          <a href="#recent-sessions" className={itemClass} onClick={onNavigate}>
            <IconMessages
              aria-hidden="true"
              size={20}
              className="shrink-0 text-foreground-strong"
            />
            Sessions
          </a>
          <button
            type="button"
            disabled
            title="Insights is not available in this preview"
            className={
              itemClass +
              " disabled:cursor-default disabled:hover:bg-transparent"
            }
          >
            <IconChartHistogram
              aria-hidden="true"
              size={20}
              className="shrink-0 text-foreground-strong"
            />
            Insights
          </button>
          <Link href="/projects" className={itemClass} onClick={onNavigate}>
            <IconSettings
              aria-hidden="true"
              size={20}
              className="shrink-0 text-foreground-strong"
            />
            Settings
          </Link>
        </div>
      </nav>
    </>
  );
}

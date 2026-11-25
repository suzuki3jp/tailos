import Link from "next/link";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { ProjectPageShell, PageContent } from "@/widgets/page-shell";
import { prefetchNavigation } from "./home-data";
import { QueryHydration } from "./providers";

export async function LegacyLayout({ children }: { children: ReactNode }) {
  const state = await prefetchNavigation((await headers()).get("Cookie") ?? "");
  return (
    <QueryHydration state={state}>
      <ProjectPageShell>
        <PageContent>
          <nav
            aria-label="設定・接続"
            className="flex flex-wrap gap-x-5 gap-y-3 text-sm text-muted-foreground"
          >
            <Link href="/projects" className="hover:text-foreground">
              Project
            </Link>
            <Link href="/connect" className="hover:text-foreground">
              Agent 接続
            </Link>
            <Link href="/mcp" className="hover:text-foreground">
              MCP 接続
            </Link>
            <Link href="/login" className="hover:text-foreground">
              アカウント
            </Link>
          </nav>
          <div className="min-w-0" lang="ja">
            {children}
          </div>
        </PageContent>
      </ProjectPageShell>
    </QueryHydration>
  );
}

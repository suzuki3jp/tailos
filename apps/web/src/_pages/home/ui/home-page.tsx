"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconMenu2, IconUser } from "@tabler/icons-react";
import { Avatar, AvatarFallback } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/shared/ui/sheet";
import { homeProjectsQueryOptions } from "../api/queries";
import { DataRequestState } from "./data-request-state";
import { HomeSidebar } from "./home-sidebar";
import { LoopComposer } from "./loop-composer";
import { RecentSessions } from "./recent-sessions";

export function HomePage() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const projects = useQuery(homeProjectsQueryOptions());
  const availableProjects = projects.isError ? [] : (projects.data ?? []);
  const projectSelection = {
    projects: availableProjects,
    value:
      availableProjects.find((project) => project.id === selectedProjectId)
        ?.id ??
      availableProjects[0]?.id ??
      null,
    onValueChange: setSelectedProjectId,
    loading: projects.isPending,
    disabled:
      projects.isPending || projects.isError || availableProjects.length === 0,
  };
  return (
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
        <HomeSidebar projectSelection={projectSelection} />
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex h-15 items-center justify-between border-b px-3 md:justify-end">
          <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden"
                  aria-label="Open navigation"
                />
              }
            >
              <IconMenu2 aria-hidden="true" />
            </SheetTrigger>
            <SheetContent
              lang="en"
              side="left"
              showCloseButton={false}
              className="gap-0 bg-sidebar p-0 data-[side=left]:w-60"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">
                Choose a project or open a Tailos page.
              </SheetDescription>
              <HomeSidebar
                projectSelection={projectSelection}
                onNavigate={() => setNavigationOpen(false)}
              />
            </SheetContent>
          </Sheet>
          <Link
            href="/login"
            aria-label="Open account"
            className="rounded-full"
          >
            <Avatar className="size-9 after:border-0">
              <AvatarFallback>
                <IconUser aria-hidden="true" size={20} />
              </AvatarFallback>
            </Avatar>
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
            {projects.isError && (
              <DataRequestState
                error={projects.error}
                retry={() => void projects.refetch()}
              />
            )}
            {!projects.isPending &&
              !projects.isError &&
              availableProjects.length === 0 && (
                <p className="text-caption text-muted-foreground">
                  No projects yet.{" "}
                  <Link href="/projects" className="underline">
                    Manage projects
                  </Link>
                </p>
              )}
            <LoopComposer projectSelection={projectSelection} />
          </section>
          <RecentSessions />
        </main>
      </div>
    </div>
  );
}

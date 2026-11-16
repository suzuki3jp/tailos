"use client";

import Link from "next/link";
import { useState } from "react";
import { IconMenu2 } from "@tabler/icons-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/shared/ui/sheet";
import { homePreview } from "../model/preview";
import { HomeSidebar } from "./home-sidebar";
import { LoopComposer } from "./loop-composer";
import { RecentSessions } from "./recent-sessions";

export function HomePage() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  return (
    <div
      className="flex min-h-dvh bg-background text-foreground"
      data-home-preview
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
              <HomeSidebar onNavigate={() => setNavigationOpen(false)} />
            </SheetContent>
          </Sheet>
          <Link
            href="/login"
            aria-label="Open account"
            className="rounded-full"
          >
            <Avatar className="size-9 after:border-0">
              <AvatarImage
                src="/assets/design-system/demo-avatar.png"
                alt=""
                width={36}
                height={36}
              />
              <AvatarFallback>S</AvatarFallback>
            </Avatar>
          </Link>
        </header>
        <main
          id="home-content"
          className="mx-auto flex w-full max-w-172 flex-col gap-15 px-6 pt-12 pb-12"
          aria-label="Home preview"
        >
          <section aria-labelledby="home-heading" className="space-y-3">
            <h1
              id="home-heading"
              className="text-page-title font-semibold text-foreground-strong"
            >
              Let’s dive into the looooop, {homePreview.username}!
            </h1>
            <LoopComposer />
          </section>
          <RecentSessions />
        </main>
      </div>
    </div>
  );
}

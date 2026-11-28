"use client";

import { Button } from "@/shared/ui/design-systems";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { IconUser } from "@tabler/icons-react";
import { accountProfileQueryOptions } from "@/entities/account";
import { Avatar } from "@/shared/ui/design-systems";

export function SidebarAccount() {
  const account = useQuery(accountProfileQueryOptions());
  const data = account.isError ? undefined : account.data;
  const unauthorized =
    account.error && "status" in account.error && account.error.status === 401;
  return (
    <div className="mt-auto shrink-0">
      <Link
        href="/login"
        className="flex h-15 min-w-0 items-center gap-2.5 px-3 hover:bg-sidebar-accent"
      >
        <Avatar
          className="size-9 after:hidden"
          src={data?.image ?? undefined}
          alt=""
          referrerPolicy="no-referrer"
          fallback={<IconUser aria-hidden="true" size={20} />}
        />
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="truncate text-caption leading-none font-medium">
            {data?.name ?? (unauthorized ? "Sign in" : "Account")}
          </span>
          {data && (
            <span className="truncate text-xs leading-none text-muted-foreground">
              {data.email}
            </span>
          )}
        </span>
      </Link>
      {account.isError && !unauthorized && (
        <div className="px-3 pb-2 text-xs text-muted-foreground">
          <p role="status">Account could not be loaded.</p>
          <Button
            unstyled
            type="button"
            className="underline"
            isDisabled={account.isFetching}
            onPress={() => void account.refetch()}
          >
            Retry account
          </Button>
        </div>
      )}
    </div>
  );
}

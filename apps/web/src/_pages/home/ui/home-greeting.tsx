"use client";

import { useQuery } from "@tanstack/react-query";
import { accountProfileQueryOptions } from "@/entities/account";

export function HomeGreeting() {
  const account = useQuery(accountProfileQueryOptions());
  const name = account.isError ? undefined : account.data?.name;
  return name ? <>, {name}</> : null;
}

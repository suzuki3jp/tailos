import { headers } from "next/headers";
import { HydrationBoundary } from "@tanstack/react-query";
import { HomePage } from "@/_pages/home";
import { prefetchHome } from "./home-data";

export async function Home() {
  const state = await prefetchHome((await headers()).get("Cookie") ?? "");
  return (
    <HydrationBoundary state={state}>
      <HomePage />
    </HydrationBoundary>
  );
}

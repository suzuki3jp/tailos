import { headers } from "next/headers";
import { HomePage } from "@/_pages/home";
import { prefetchHome } from "./home-data";
import { QueryHydration } from "./providers";

export async function Home() {
  const state = await prefetchHome((await headers()).get("Cookie") ?? "");
  return (
    <QueryHydration state={state}>
      <HomePage />
    </QueryHydration>
  );
}

"use client";

import {
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
  type DehydratedState,
} from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { CSPProvider } from "@base-ui/react/csp-provider";

// Keep hydration on the same client import path as the provider. Vinext dev can
// otherwise load a second Query context for a direct Server Component import.
export function QueryHydration({
  children,
  state,
}: {
  children: ReactNode;
  state: DehydratedState;
}) {
  return <HydrationBoundary state={state}>{children}</HydrationBoundary>;
}

export function Providers({
  children,
  nonce,
}: {
  children: ReactNode;
  nonce?: string;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
  );
  return (
    <CSPProvider nonce={nonce}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </CSPProvider>
  );
}

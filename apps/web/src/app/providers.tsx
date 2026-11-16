"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { CSPProvider } from "@base-ui/react/csp-provider";

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

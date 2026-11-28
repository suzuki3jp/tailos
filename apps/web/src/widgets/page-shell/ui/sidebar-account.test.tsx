import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { accountProfileQueryOptions } from "@/entities/account";
import { SidebarAccount } from "./sidebar-account";

vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => createElement("a", props),
}));

const profile = {
  name: "Current operator",
  email: "current@example.test",
  image: null,
};

test("renders the prefetched identity on the initial server response", () => {
  const client = new QueryClient();
  client.setQueryData(accountProfileQueryOptions().queryKey, profile);
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SidebarAccount />
      </QueryClientProvider>,
    );
    expect(html).toContain(profile.name);
    expect(html).toContain(profile.email);
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("Retry account");
  } finally {
    client.clear();
  }
});

test.each([401, 503])(
  "does not show stale identity after profile HTTP %i",
  async (status) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = accountProfileQueryOptions();
    client.setQueryData(options.queryKey, profile);
    try {
      await expect(
        client.fetchQuery({
          ...options,
          queryFn: async () => {
            throw Object.assign(new Error("Profile failed"), { status });
          },
        }),
      ).rejects.toThrow();
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <SidebarAccount />
        </QueryClientProvider>,
      );
      expect(html).not.toContain(profile.name);
      expect(html).not.toContain(profile.email);
      if (status === 401) {
        expect(html).toContain("Sign in");
        expect(html).not.toContain("Retry account");
      } else {
        expect(html).toContain("Retry account");
        expect(html).toContain("Account could not be loaded.");
      }
    } finally {
      client.clear();
    }
  },
);

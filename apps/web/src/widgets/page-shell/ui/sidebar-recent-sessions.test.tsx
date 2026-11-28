import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import {
  accountSessionsQueryOptions,
  type AccountSession,
} from "@/entities/session";
import { SidebarRecentSessions } from "./sidebar-recent-sessions";

vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => createElement("a", props),
}));

afterEach(() => vi.unstubAllGlobals());

function session(index: number): AccountSession {
  return {
    id: `s${index}`,
    title: `Session ${index}`,
    createdAt: 1_600_000_000_000,
    updatedAt: 1_700_000_000_000 - index,
    trigger: null,
    latestRun: { id: `r${index}`, status: "running", errorCode: null },
    project: { id: "p1" },
  };
}

function render(client: QueryClient, activeSessionId?: string) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SidebarRecentSessions activeSessionId={activeSessionId} />
    </QueryClientProvider>,
  );
}

test("lists up to ten account-wide Sessions once, marking the open one without unread marks", () => {
  const client = new QueryClient();
  const first = Array.from({ length: 8 }, (_, index) => session(index + 1));
  // A Session updated between pages can appear on both.
  const second = [session(8), ...[9, 10, 11].map(session)];
  client.setQueryData(accountSessionsQueryOptions().queryKey, {
    pages: [
      { items: first, nextCursor: "next" },
      { items: second, nextCursor: null },
    ],
    pageParams: ["", "next"],
  });
  try {
    const html = render(client, "s2");
    expect(html).toContain("Recent Sessions");
    expect(html.match(/href="\/p1\/sessions\/s\d+"/g)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `href="/p1/sessions/s${index + 1}"`,
      ),
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/p1\/sessions\/s2"[^>]*aria-current="page"/);
    // Run state is not read state.
    expect(html).not.toContain("Unread");
    expect(html).not.toContain("Load more");
  } finally {
    client.clear();
  }
});

test("shows an empty list", () => {
  const client = new QueryClient();
  client.setQueryData(accountSessionsQueryOptions().queryKey, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [""],
  });
  try {
    expect(render(client)).toContain("No sessions yet.");
  } finally {
    client.clear();
  }
});

test.each([
  { status: 401, shown: false },
  { status: 503, shown: true },
])(
  "leaves sign-in to the account footer and offers a retry for other failures (HTTP $status)",
  async ({ status, shown }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status })),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    try {
      await client.prefetchInfiniteQuery(accountSessionsQueryOptions());
      const html = render(client);
      expect(html.includes("Recent Sessions")).toBe(shown);
      expect(html.includes("Retry sessions")).toBe(shown);
    } finally {
      client.clear();
    }
  },
);

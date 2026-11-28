import { projectsQueryOptions } from "@/features/select-project";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { accountSessionsQueryOptions } from "@/entities/session";
import { ProjectSelectionProvider } from "@/features/select-project";
import { ProjectStatus } from "./project-status";
import { SessionList } from "./session-list";

vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => createElement("a", props),
}));

afterEach(() => vi.unstubAllGlobals());

test("renders only the first five sessions and retains the full response in cache", async () => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: `s${index + 1}`,
    title: `Session ${index + 1}`,
    updatedAt: 1_700_000_000_000 - index,
    trigger: null,
    latestRun: null,
  }));
  const page = { items, nextCursor: "next" };
  const http = vi.fn<typeof fetch>(async () => Response.json(page));
  vi.stubGlobal("fetch", http);
  const client = new QueryClient();
  const options = accountSessionsQueryOptions();
  try {
    await client.fetchInfiniteQuery(options);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProjectSelectionProvider>
          <SessionList />
        </ProjectSelectionProvider>
      </QueryClientProvider>,
    );
    expect(html.match(/href="\/sessions\/s\d+"/g)).toEqual(
      items.slice(0, 5).map(({ id }) => `href="/sessions/${id}"`),
    );
    expect(html).not.toContain("Load more sessions");
    expect(client.getQueryData(options.queryKey)).toMatchObject({
      pages: [page],
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(
      new URL(String(http.mock.calls[0]?.[0])).searchParams.has("limit"),
    ).toBe(false);
  } finally {
    client.clear();
  }
});

test.each([
  { projects: 401, sessions: 401 },
  { projects: 200, sessions: 401 },
  { projects: 503, sessions: 401 },
  { projects: 401, sessions: 200 },
])(
  "shows one login action for Projects $projects and Sessions $sessions",
  async ({ projects, sessions }) => {
    const http = vi.fn<typeof fetch>(async (input) => {
      const status = new URL(String(input)).pathname.endsWith("/projects")
        ? projects
        : sessions;
      return status === 200
        ? Response.json({ items: [], nextCursor: null })
        : new Response(null, { status });
    });
    vi.stubGlobal("fetch", http);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    try {
      await Promise.all([
        client.prefetchQuery(projectsQueryOptions()),
        client.prefetchInfiniteQuery(accountSessionsQueryOptions()),
      ]);
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <ProjectSelectionProvider>
            <ProjectStatus />
            <SessionList />
          </ProjectSelectionProvider>
        </QueryClientProvider>,
      );
      expect(html.match(/GitHub でログイン/g)).toHaveLength(1);
      if (projects === 503) {
        expect(html).toContain('role="alert"');
        expect(html).toContain("再試行");
      }
      expect(http).toHaveBeenCalledTimes(2);
    } finally {
      client.clear();
    }
  },
);

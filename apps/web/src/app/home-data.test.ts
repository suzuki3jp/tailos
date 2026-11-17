import {
  hydrate,
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { prefetchHome } from "./home-data";
import {
  homeProjectsQueryOptions,
  homeSessionsQueryOptions,
} from "@/_pages/home/index.server";
import { apiOrigin } from "@/shared/config";

afterEach(() => vi.unstubAllGlobals());
const cookieName = `${apiOrigin.startsWith("https:") ? "__Secure-" : ""}tailos.session_token`;

test("starts both protected lists before awaiting either and hydrates without a browser fetch", async () => {
  const pending = new Map<string, (response: Response) => void>();
  const http = vi.fn<typeof fetch>(
    (input, init) =>
      new Promise((resolve) => {
        expect(new URL(String(input)).origin).toBe(apiOrigin);
        expect(new Headers(init?.headers).get("Cookie")).toBe(
          `${cookieName}=test-session`,
        );
        expect(init).toMatchObject({
          cache: "no-store",
          redirect: "manual",
          signal: expect.any(AbortSignal),
        });
        pending.set(new URL(String(input)).pathname, resolve);
      }),
  );
  vi.stubGlobal("fetch", http);
  const result = prefetchHome(
    `unrelated=private; ${cookieName}=test-session; tracking=private`,
  );
  await vi.waitFor(() =>
    expect([...pending.keys()].sort()).toEqual([
      "/api/projects",
      "/api/sessions",
    ]),
  );
  const project = {
    id: "p1",
    name: "Server project",
    repository: "owner/repo",
  };
  pending.get("/api/projects")?.(
    Response.json({ items: [project], nextCursor: null }),
  );
  pending.get("/api/sessions")?.(
    Response.json({ items: [], nextCursor: null }),
  );
  const state = await result;
  const serialized = JSON.stringify(state);
  expect(serialized).not.toContain("test-session");
  expect(serialized).not.toContain("private");
  const client = new QueryClient();
  hydrate(client, JSON.parse(serialized));
  const projects = new QueryObserver(client, homeProjectsQueryOptions());
  const sessions = new InfiniteQueryObserver(
    client,
    homeSessionsQueryOptions(),
  );
  const offProjects = projects.subscribe(() => {});
  const offSessions = sessions.subscribe(() => {});
  try {
    expect(projects.getCurrentResult().data).toEqual([project]);
    expect(sessions.getCurrentResult().data?.pages[0]?.items).toEqual([]);
    await Promise.resolve();
    expect(http).toHaveBeenCalledTimes(2);
  } finally {
    offProjects();
    offSessions();
    projects.destroy();
    sessions.destroy();
    client.clear();
  }
});

test.each([401, 503])(
  "hydrates HTTP %i as an error instead of an empty result or a new request",
  async (status) => {
    const http = vi.fn<typeof fetch>(
      async () => new Response(null, { status }),
    );
    vi.stubGlobal("fetch", http);
    const state = await prefetchHome(`${cookieName}=session-secret`);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("session-secret");
    for (const query of state.queries) {
      expect(query.state.status).toBe("error");
      expect(Object.getPrototypeOf(query.state.error)).toBe(Object.prototype);
      expect(query.state.error).toMatchObject({ status });
    }
    const client = new QueryClient();
    hydrate(client, JSON.parse(serialized));
    const projects = new QueryObserver(client, homeProjectsQueryOptions());
    const off = projects.subscribe(() => {});
    try {
      expect(projects.getCurrentResult().error).toMatchObject({ status });
      await Promise.resolve();
      expect(http).toHaveBeenCalledTimes(2);
    } finally {
      off();
      projects.destroy();
      client.clear();
    }
  },
);

test("request caches are isolated and unexpected fetch failures are redacted", async () => {
  const http = vi.fn<typeof fetch>(async (_input, init) => {
    const cookie = new Headers(init?.headers).get("Cookie");
    if (cookie?.includes("second"))
      throw new Error("internal details not-for-browser");
    return Response.json({ items: [], nextCursor: null });
  });
  vi.stubGlobal("fetch", http);
  const first = await prefetchHome(`${cookieName}=first`);
  const second = await prefetchHome(`${cookieName}=second`);
  expect(first.queries.every((query) => query.state.status === "success")).toBe(
    true,
  );
  expect(second.queries.every((query) => query.state.status === "error")).toBe(
    true,
  );
  expect(JSON.stringify(second)).not.toContain("internal details");
  expect(JSON.stringify(second)).not.toContain("not-for-browser");
  expect(http).toHaveBeenCalledTimes(4);
});

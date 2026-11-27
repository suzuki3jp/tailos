import { projectsQueryOptions } from "@/features/select-project";
import {
  hydrate,
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { prefetchNavigation } from "./home-data";
import { accountSessionsQueryOptions } from "@/entities/session";
import { accountProfileQueryOptions } from "@/entities/account";
import { apiOrigin } from "@/shared/config";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const cookieName = `${apiOrigin.startsWith("https:") ? "__Secure-" : ""}tailos.session_token`;

test("starts the profile and both protected lists before awaiting either and hydrates without a browser fetch", async () => {
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
  const result = prefetchNavigation(
    `unrelated=private; ${cookieName}=test-session; tracking=private`,
  );
  await vi.waitFor(() =>
    expect([...pending.keys()].sort()).toEqual([
      "/v1/account/profile",
      "/v1/projects",
      "/v1/sessions",
    ]),
  );
  pending.get("/v1/account/profile")?.(
    Response.json({
      name: "Operator",
      email: "operator@example.test",
      image: null,
    }),
  );
  const project = {
    id: "p1",
    name: "Server project",
    repository: "owner/repo",
  };
  pending.get("/v1/projects")?.(
    Response.json({ items: [project], nextCursor: null }),
  );
  pending.get("/v1/sessions")?.(Response.json({ items: [], nextCursor: null }));
  const state = await result;
  const serialized = JSON.stringify(state);
  expect(serialized).not.toContain("test-session");
  expect(serialized).not.toContain("private");
  const client = new QueryClient();
  hydrate(client, JSON.parse(serialized));
  const projects = new QueryObserver(client, projectsQueryOptions());
  const sessions = new InfiniteQueryObserver(
    client,
    accountSessionsQueryOptions(),
  );
  const profile = new QueryObserver(client, accountProfileQueryOptions());
  const offProfile = profile.subscribe(() => {});
  const offProjects = projects.subscribe(() => {});
  const offSessions = sessions.subscribe(() => {});
  try {
    expect(profile.getCurrentResult().data?.name).toBe("Operator");
    expect(projects.getCurrentResult().data).toEqual([project]);
    expect(sessions.getCurrentResult().data?.pages[0]?.items).toEqual([]);
    await Promise.resolve();
    expect(http).toHaveBeenCalledTimes(3);
  } finally {
    offProfile();
    profile.destroy();
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
    const state = await prefetchNavigation(`${cookieName}=session-secret`);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("session-secret");
    for (const query of state.queries) {
      expect(query.state.status).toBe("error");
      expect(Object.getPrototypeOf(query.state.error)).toBe(Object.prototype);
      expect(query.state.error).toMatchObject({ status });
    }
    const client = new QueryClient();
    hydrate(client, JSON.parse(serialized));
    const projects = new QueryObserver(client, projectsQueryOptions());
    const off = projects.subscribe(() => {});
    try {
      expect(projects.getCurrentResult().error).toMatchObject({ status });
      await Promise.resolve();
      expect(http).toHaveBeenCalledTimes(3);
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
  const first = await prefetchNavigation(`${cookieName}=first`);
  const second = await prefetchNavigation(`${cookieName}=second`);
  expect(first.queries.every((query) => query.state.status === "success")).toBe(
    true,
  );
  expect(second.queries.every((query) => query.state.status === "error")).toBe(
    true,
  );
  expect(JSON.stringify(second)).not.toContain("internal details");
  expect(JSON.stringify(second)).not.toContain("not-for-browser");
  expect(http).toHaveBeenCalledTimes(6);
});

function waitForAbort(
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  if (!signal) throw new Error("Missing fetch signal");
  signal.throwIfAborted();
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

test.each([
  { slow: ["projects"] },
  { slow: ["sessions"] },
  { slow: ["projects", "sessions"] },
])(
  "stops $slow at ten seconds and preserves completed lists",
  async ({ slow }) => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const http = vi.fn<typeof fetch>(async (input, init) => {
      if (slow.some((name) => new URL(String(input)).pathname.endsWith(name))) {
        if (init?.signal) signals.push(init.signal);
        return waitForAbort(init?.signal);
      }
      return Response.json({ items: [], nextCursor: null });
    });
    vi.stubGlobal("fetch", http);
    let settled = false;
    const pending = prefetchNavigation(
      `${cookieName}=deadline-test-session`,
    ).then((state) => {
      settled = true;
      return state;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const state = await pending;
    expect(state.queries).toHaveLength(3);
    for (const query of state.queries) {
      const timedOut = slow.includes(String(query.queryKey[0]));
      expect(query.state.status).toBe(timedOut ? "error" : "success");
      if (timedOut) {
        expect(query.state.error).toEqual({
          name: "HomeRequestError",
          message: "Data could not be loaded.",
        });
      } else {
        expect(query.state.data).toBeDefined();
      }
    }
    expect(JSON.stringify(state)).not.toContain("deadline-test-session");
    expect(JSON.stringify(state)).not.toContain("timed out");
    expect(vi.getTimerCount()).toBe(0);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    hydrate(client, JSON.parse(JSON.stringify(state)));
    const projects = new QueryObserver(client, projectsQueryOptions());
    const sessions = new InfiniteQueryObserver(
      client,
      accountSessionsQueryOptions(),
    );
    const offProjects = projects.subscribe(() => {});
    const offSessions = sessions.subscribe(() => {});
    try {
      await Promise.resolve();
      expect(http).toHaveBeenCalledTimes(3);
      http.mockImplementation(async (_input, init) => {
        expect(init?.signal?.aborted).toBe(false);
        expect(new Headers(init?.headers).has("Cookie")).toBe(false);
        return Response.json({ items: [], nextCursor: null });
      });
      const retried = await (slow.includes("projects")
        ? projects.refetch()
        : sessions.refetch());
      expect(retried.status).toBe("success");
      expect(http).toHaveBeenCalledTimes(4);
    } finally {
      offProjects();
      offSessions();
      projects.destroy();
      sessions.destroy();
      client.clear();
    }
  },
);

test("project pages share the original deadline instead of resetting it", async () => {
  vi.useFakeTimers();
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/sessions"))
      return Response.json({ items: [], nextCursor: null });
    if (!url.searchParams.has("cursor"))
      return new Promise((resolve) => {
        setTimeout(
          () => resolve(Response.json({ items: [], nextCursor: "next" })),
          6_000,
        );
      });
    return waitForAbort(init?.signal);
  });
  vi.stubGlobal("fetch", http);
  const pending = prefetchNavigation("");
  await vi.advanceTimersByTimeAsync(6_000);
  expect(http).toHaveBeenCalledTimes(4);
  const lastSignal = http.mock.calls[3]?.[1]?.signal;
  expect(lastSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(3_999);
  expect(lastSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(lastSignal?.aborted).toBe(true);
  const state = await pending;
  expect(
    state.queries.find((query) => query.queryKey[0] === "projects")?.state
      .status,
  ).toBe("error");
  expect(
    state.queries.find((query) => query.queryKey[0] === "sessions")?.state
      .status,
  ).toBe("success");
});

test("successful prefetch clears its timer", async () => {
  vi.useFakeTimers();
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({ items: [], nextCursor: null }),
  );
  vi.stubGlobal("fetch", http);
  await prefetchNavigation("");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(http.mock.calls.every((call) => !call[1]?.signal?.aborted)).toBe(true);
});

test("management navigation prefetches the sidebar's Recent Sessions with the profile and projects", async () => {
  const http = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    return Response.json(
      path.endsWith("/profile")
        ? { name: "Operator", email: "operator@example.test", image: null }
        : { items: [], nextCursor: null },
    );
  });
  vi.stubGlobal("fetch", http);
  const state = await prefetchNavigation("");
  expect(
    http.mock.calls.map(([input]) => new URL(String(input)).pathname).sort(),
  ).toEqual(["/v1/account/profile", "/v1/projects", "/v1/sessions"]);
  expect(state.queries).toHaveLength(3);
  expect(state.queries.every((query) => query.state.status === "success")).toBe(
    true,
  );
});

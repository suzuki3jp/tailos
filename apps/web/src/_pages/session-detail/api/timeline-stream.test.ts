import { afterEach, expect, test, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { TimelineItem, TimelineSnapshot } from "@tailos/core/timeline";
import { openSessionTimeline } from "./timeline-stream";
import { timelineQueryOptions } from "./timeline";
import { accountSessionsQueryOptions } from "@/entities/session";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor() {
    Socket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const item: TimelineItem = {
  id: "command",
  runId: "run",
  kind: "command",
  label: "pnpm test",
  text: null,
  status: "running",
  startedAt: 1,
  finishedAt: null,
  durationMs: null,
  exitCode: null,
  revision: 1,
  bodyExpiresAt: 9999999999999,
  hasInput: true,
  hasOutput: false,
};
const saved: TimelineSnapshot = {
  items: [item],
  cursor: 1,
  before: null,
  captures: [{ runId: "run", state: "collecting", dropped: 0 }],
};
const key = timelineQueryOptions("project", "session").queryKey;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Socket.instances = [];
});

function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  const cache = new QueryClient();
  cache.setQueryData(key, saved);
  const state = vi.fn();
  const stop = openSessionTimeline(cache, "project", "session", state);
  return { cache, state, stop };
}

test("a reconnect processes new frames while the previous reset request is pending and ignores its late snapshot", async () => {
  let finishOld!: (response: Response) => void;
  const oldRequest = new Promise<Response>((resolve) => {
    finishOld = resolve;
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(oldRequest)
    .mockImplementation(async () => Response.json(saved));
  vi.stubGlobal("fetch", fetch);
  const { cache, stop } = setup();
  try {
    const first = Socket.instances[0];
    first.open();
    first.message({ type: "reset_required" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    first.close(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(Socket.instances).toHaveLength(2);
    const second = Socket.instances[1];
    second.open();
    expect(second.sent[0]).toEqual({ type: "resume", after: 1 });
    second.message({
      type: "changes",
      cursor: 2,
      items: [
        {
          ...item,
          revision: 2,
          status: "succeeded",
          hasOutput: true,
          finishedAt: 2,
        },
      ],
      hasMore: false,
      sessionChanged: false,
      captureChanged: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.getQueryData<TimelineSnapshot>(key)).toMatchObject({
      cursor: 2,
      items: [{ status: "succeeded" }],
    });
    expect(second.sent).toContainEqual({ type: "ack", cursor: 2 });
    finishOld(Response.json(saved));
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.getQueryData<TimelineSnapshot>(key)).toMatchObject({
      cursor: 2,
      items: [{ status: "succeeded" }],
    });
    expect(Socket.instances).toHaveLength(2);
  } finally {
    stop();
    cache.clear();
  }
});

test("authentication revocation stops reconnects and blocks an in-flight reset from applying", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const { cache, state, stop } = setup();
  try {
    const socket = Socket.instances[0];
    socket.open();
    socket.message({ type: "reset_required" });
    await vi.advanceTimersByTimeAsync(0);
    socket.close(1008);
    finish(Response.json({ ...saved, cursor: 99, items: [] }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state).toHaveBeenLastCalledWith("unauthorized");
    expect(Socket.instances).toHaveLength(1);
    expect(cache.getQueryData<TimelineSnapshot>(key)?.cursor).toBe(1);
  } finally {
    stop();
    cache.clear();
  }
});

test("blocked WebSockets still reconcile Run state through HTTP on reconnect attempts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(saved)),
  );
  const { cache, stop } = setup();
  const detailKey = ["projects", "project", "sessions", "session"];
  cache.setQueryData(detailKey, { status: "running" });
  const readSession = vi.fn(async () => ({ status: "succeeded" }));
  const observer = new QueryObserver(cache, {
    queryKey: detailKey,
    queryFn: readSession,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(readSession).not.toHaveBeenCalled();
    Socket.instances[0].close(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cache.getQueryData(detailKey)).toEqual({ status: "succeeded" });
    expect(readSession).toHaveBeenCalledTimes(1);
    Socket.instances[1].close(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(Socket.instances).toHaveLength(3);
  } finally {
    unsubscribe();
    stop();
    cache.clear();
  }
});

test("Session changes refresh the sidebar's Recent Sessions", async () => {
  const { cache, stop } = setup();
  const sessionsKey = accountSessionsQueryOptions().queryKey;
  cache.setQueryData(sessionsKey, {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [""],
  });
  try {
    const socket = Socket.instances[0];
    socket.open();
    socket.message({
      type: "changes",
      cursor: 2,
      items: [],
      hasMore: false,
      sessionChanged: true,
      captureChanged: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.getQueryState(sessionsKey)?.isInvalidated).toBe(true);
  } finally {
    stop();
    cache.clear();
  }
});

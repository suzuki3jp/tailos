import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import {
  routinesQueryOptions,
  routineHistoryQueryOptions,
  saveRoutine,
  deleteRoutine,
  RoutineRequestError,
  type RoutineSettings,
  type Routine,
} from "./routines";
afterEach(() => vi.unstubAllGlobals());
const projectId = "00000000-0000-4000-8000-000000000001";
const settings: RoutineSettings = {
  name: "Build",
  enabled: false,
  trigger: { version: 1, type: "github.issue-label", label: "build" },
  allowedActors: ["builder"],
  engine: "codex",
  prompt: "Implement the issue",
  model: "unknown-model",
  effort: "high",
};
test("Routine reads carry credentials, cancellation, and project scope and preserve authentication failures", async () => {
  const http = vi.fn<typeof fetch>(async () => Response.json({ routines: [] }));
  vi.stubGlobal("fetch", http);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    await client.fetchQuery(routinesQueryOptions(projectId));
    expect(String(http.mock.lastCall![0])).toContain(
      `/v1/projects/${projectId}/routines`,
    );
    expect(http.mock.lastCall![1]).toMatchObject({
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
    await client.fetchQuery(routineHistoryQueryOptions(projectId, 50));
    expect(String(http.mock.lastCall![0])).toContain("history?before=50");
    http.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      client.fetchQuery(routinesQueryOptions(projectId)),
    ).rejects.toEqual(new RoutineRequestError(401));
  } finally {
    client.clear();
  }
});
test("disabled unverified settings retain their requested options and updates/deletion carry the current revision", async () => {
  const http = vi.fn<typeof fetch>(async () => Response.json({}));
  vi.stubGlobal("fetch", http);
  const current: Routine = {
    ...settings,
    id: "00000000-0000-4000-8000-000000000002",
    projectId,
    revision: 3,
    deletedAt: null,
  };
  await saveRoutine(projectId, settings);
  expect(JSON.parse(String(http.mock.lastCall![1]?.body))).toEqual(settings);
  await saveRoutine(projectId, { ...settings, enabled: true }, current);
  expect(JSON.parse(String(http.mock.lastCall![1]?.body))).toEqual({
    ...settings,
    enabled: true,
    revision: 3,
  });
  await deleteRoutine(projectId, current);
  expect(String(http.mock.lastCall![0])).toContain(`/${current.id}/delete`);
  expect(JSON.parse(String(http.mock.lastCall![1]?.body))).toEqual({
    revision: 3,
  });
  http.mockResolvedValue(
    Response.json({ error: "configuration_unverified" }, { status: 503 }),
  );
  await expect(
    saveRoutine(projectId, { ...settings, enabled: true }),
  ).rejects.toThrow(/無効状態なら保存できます/);
  expect(http).toHaveBeenCalledTimes(4);
});

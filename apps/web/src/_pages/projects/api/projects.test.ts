import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import {
  projectsQueryOptions,
  repositoriesQueryOptions,
  projectHistoryQueryOptions,
} from "./queries";
import { saveProject, deleteProject, importProjects } from "./mutations";

afterEach(() => vi.unstubAllGlobals());
const settings = {
  repository: "owner/repo",
  repositoryId: 42,
  installationId: 19,
  triggerLabel: "tailos:run",
  allowedActors: ["operator"],
  agentNetworkAccess: false,
  maxRunMinutes: 30,
};
test("reads protected projects, candidates and history with credentials and cancellation, preserving error statuses", async () => {
  const http = vi.fn<typeof fetch>(async () => Response.json({ projects: [] }));
  vi.stubGlobal("fetch", http);
  const client = new QueryClient();
  try {
    await client.fetchQuery(projectsQueryOptions());
    await client.fetchQuery(repositoriesQueryOptions());
    await client.fetchQuery(projectHistoryQueryOptions(50));
    for (const call of http.mock.calls) {
      expect(call).toEqual([
        expect.anything(),
        expect.objectContaining({
          credentials: "include",
          signal: expect.any(AbortSignal),
        }),
      ]);
    }
    expect(String(http.mock.lastCall?.[0])).toContain("before=50");
    for (const status of [401, 403, 503]) {
      http.mockImplementation(async () => new Response(null, { status }));
      await client.invalidateQueries();
      expect(await client.fetchQuery(projectsQueryOptions())).toEqual({
        error: status,
      });
    }
  } finally {
    client.clear();
  }
});

test("writes settings and revisions as JSON and surfaces conflicts without automatically retrying a mutation", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const http = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      path: new URL(String(input)).pathname,
      body: JSON.parse(String(init?.body)),
    });
    expect(init?.credentials).toBe("include");
    return Response.json({});
  });
  vi.stubGlobal("fetch", http);
  await saveProject(settings);
  await saveProject(settings, "id", 3);
  await deleteProject("id", 4);
  await importProjects(JSON.stringify([{ ...settings, id: "meguri" }]));
  expect(requests).toEqual([
    { path: "/api/projects", body: settings },
    { path: "/api/projects/id", body: { ...settings, revision: 3 } },
    { path: "/api/projects/id/delete", body: { revision: 4 } },
    { path: "/api/projects/import", body: [{ ...settings, id: "meguri" }] },
  ]);
  http.mockImplementation(async () => new Response(null, { status: 409 }));
  await expect(saveProject(settings, "id", 3)).rejects.toThrow(/一覧を更新/);
  expect(http).toHaveBeenCalledTimes(5);
  await expect(importProjects("bad JSON")).rejects.toThrow(/JSON/);
  expect(http).toHaveBeenCalledTimes(5);
});

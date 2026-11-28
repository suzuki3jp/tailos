import { afterEach, expect, test, vi } from "vitest";
import { startSession, StartSessionError } from "./start-session";

afterEach(() => vi.unstubAllGlobals());

const input = {
  projectId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  message: "Add a health check",
  model: "gpt-5.5",
  effort: "high",
};

test("posts the message to the project's sessions with credentials and returns the new Session", async () => {
  const started = {
    sessionId: "session",
    runId: "run",
    projectId: input.projectId,
  };
  const http = vi.fn<typeof fetch>(async () =>
    Response.json(started, { status: 201 }),
  );
  vi.stubGlobal("fetch", http);
  expect(await startSession(input)).toEqual(started);
  const [url, init] = http.mock.calls[0]!;
  expect(String(url)).toMatch(
    new RegExp(`/v1/projects/${input.projectId}/sessions$`),
  );
  expect(init).toMatchObject({ method: "POST", credentials: "include" });
  expect(JSON.parse(String(init?.body))).toEqual({
    requestId: input.requestId,
    message: input.message,
    model: "gpt-5.5",
    effort: "high",
  });
});

test("surfaces the status and error code without retrying", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({ error: "codex_not_connected" }, { status: 409 }),
  );
  vi.stubGlobal("fetch", http);
  const error = await startSession(input).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(StartSessionError);
  expect(error).toMatchObject({ status: 409, code: "codex_not_connected" });
  http.mockImplementation(async () => new Response(null, { status: 503 }));
  await expect(startSession(input)).rejects.toMatchObject({
    status: 503,
    code: undefined,
  });
  http.mockImplementation(async () =>
    Response.json({ error: { message: "internal details" } }, { status: 500 }),
  );
  await expect(startSession(input)).rejects.toMatchObject({
    status: 500,
    code: undefined,
  });
  expect(http).toHaveBeenCalledTimes(3);
});

import { afterEach, expect, test, vi } from "vitest";
import { sendMessage, SendMessageError } from "./send-message";

afterEach(() => vi.unstubAllGlobals());

const input = {
  projectId: "11111111-1111-4111-8111-111111111111",
  sessionId: "33333333-3333-4333-8333-333333333333",
  requestId: "22222222-2222-4222-8222-222222222222",
  message: "Also log it",
};

test("posts the message to the Session with credentials and returns its Turn", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({ runId: "run" }, { status: 201 }),
  );
  vi.stubGlobal("fetch", http);
  expect(await sendMessage(input)).toEqual({ runId: "run" });
  const [url, init] = http.mock.calls[0]!;
  expect(String(url)).toMatch(
    new RegExp(
      `/v1/projects/${input.projectId}/sessions/${input.sessionId}/messages$`,
    ),
  );
  expect(init).toMatchObject({ method: "POST", credentials: "include" });
  expect(JSON.parse(String(init?.body))).toEqual({
    requestId: input.requestId,
    message: input.message,
  });
});

test("surfaces a working Session without retrying", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({ error: "session_busy" }, { status: 409 }),
  );
  vi.stubGlobal("fetch", http);
  const error = await sendMessage(input).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SendMessageError);
  expect(error).toMatchObject({ status: 409, code: "session_busy" });
  expect(http).toHaveBeenCalledOnce();
});

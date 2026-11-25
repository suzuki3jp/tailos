import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import Page from "./page";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));

afterEach(() => vi.unstubAllGlobals());

test("renders prefetched session and execution history without waiting for the live connection", async () => {
  const http = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/account/profile")
      return Response.json({
        name: "Session Operator",
        email: "session@example.test",
        image: null,
      });
    if (path.endsWith("/timeline"))
      return Response.json({
        items: [],
        captures: [],
        cursor: 0,
        before: null,
      });
    if (path === "/v1/projects/project/sessions")
      return Response.json({
        items: [{ id: "session", title: "Sample session" }],
        nextCursor: null,
      });
    if (path === "/v1/projects/project/sessions/session")
      return Response.json({
        projectName: "Sample project",
        detail: {
          session: { id: "session", title: "Sample session" },
          messages: [
            {
              id: "prompt",
              authorKind: "automation",
              body: "**Prompt**",
              jobContext: { github: { kind: "issue", number: 166 } },
            },
            {
              id: "reply",
              authorKind: "agent",
              runId: "run",
              body: "<b>Reply</b>",
            },
          ],
          runs: [
            {
              id: "run",
              startMessageId: "prompt",
              status: "succeeded",
              agentDurationMs: 752_000,
              result: null,
              errorCode: null,
            },
          ],
          timeline: { items: [], captures: [], cursor: 0, before: null },
        },
      });
    throw new Error(`Unexpected request to ${path}`);
  });
  vi.stubGlobal("fetch", http);
  const page = await Page({
    params: Promise.resolve({ projectId: "project", sessionId: "session" }),
  });
  const { Providers } = await import("@/app/providers");
  const html = renderToStaticMarkup(<Providers>{page}</Providers>);
  expect(html).toContain("Sample project");
  expect(html).toContain('href="/project/sessions/session"');
  expect(html).toMatch(
    /<div[^>]*aria-label="Resize session list"[^>]*role="separator"/,
  );
  expect(html).toMatch(/id="project-sessions"[^>]*flex-basis:240px/);
  expect(html).toContain("**Prompt**");
  expect(html).toMatch(
    /\*\*Prompt\*\*<\/p>.*Structured Job Context[\s\S]*?&quot;number&quot;: 166[\s\S]*?<\/pre><\/div><\/div><\/li>/,
  );
  expect(html).toContain("&lt;b&gt;Reply&lt;/b&gt;");
  expect(html).toContain("Worked for 12m 32s");
  expect(html).toContain("<summary");
  expect(html).not.toContain("Execution history could not be loaded.");
  expect(html).toContain("Session Operator");
  expect(html).toContain("session@example.test");
  expect(http).toHaveBeenCalledTimes(3);
});

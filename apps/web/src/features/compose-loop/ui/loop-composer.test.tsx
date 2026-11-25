import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LoopComposer } from "./loop-composer";
import { modelEffortValue, parseModelEffort } from "../model/model-effort";

test("shares the model control and keeps the session composer editable with sending disabled", () => {
  const client = new QueryClient();
  try {
    const render = (mode: "home" | "session") =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <LoopComposer
            mode={mode}
            message=""
            onMessageChange={() => {}}
            projectSelect={<button type="button">Pick a project</button>}
          />
        </QueryClientProvider>,
      );
    const session = render("session");
    expect(session).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Send message"/,
    );
    expect(session).toMatch(/<textarea[^>]*aria-label="Message"/);
    expect(session).toContain('aria-label="Model provider, model and effort"');
    expect(session).not.toContain("Pick a project");
    const home = render("home");
    expect(home).toContain("Pick a project");
    // Without a send handler, the home composer cannot send either.
    expect(home).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Start loop"/);
    expect(home).toContain('aria-label="Model provider, model and effort"');
  } finally {
    client.clear();
  }
});

test("home sending is enabled with a handler and shows the send status", () => {
  const client = new QueryClient();
  try {
    const render = (props: Partial<Parameters<typeof LoopComposer>[0]>) =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <LoopComposer
            mode="home"
            message=""
            onMessageChange={() => {}}
            onSubmit={() => {}}
            {...props}
          />
        </QueryClientProvider>,
      );
    expect(render({})).not.toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Start loop"/,
    );
    for (const blocked of [{ pending: true }, { disabled: true }])
      expect(render(blocked)).toMatch(
        /<button[^>]*disabled=""[^>]*aria-label="Start loop"/,
      );
    const failed = render({ status: "Your message wasn’t sent." });
    expect(failed).toContain('role="status"');
    expect(failed).toMatch(/<textarea[^>]*aria-describedby="/);
  } finally {
    client.clear();
  }
});

test("provider, model and effort selections round-trip, and the default leaves them unset", () => {
  expect(parseModelEffort("default")).toEqual({});
  expect(parseModelEffort(modelEffortValue("claude"))).toEqual({
    engine: "claude",
  });
  expect(parseModelEffort(modelEffortValue("codex", "gpt-5.5"))).toEqual({
    engine: "codex",
    model: "gpt-5.5",
  });
  expect(
    parseModelEffort(modelEffortValue("claude", "claude-opus-5-5", "max")),
  ).toEqual({ engine: "claude", model: "claude-opus-5-5", effort: "max" });
  expect(parseModelEffort('["gemini", null, null]')).toEqual({});
  expect(parseModelEffort("not json")).toEqual({});
});

test("a Session's composer offers only its own Model Provider", () => {
  const render = (engine?: "codex" | "claude") =>
    renderToStaticMarkup(
      <LoopComposer
        mode="session"
        message=""
        onMessageChange={() => {}}
        engine={engine}
      />,
    );
  // The closed select shows the default, named after the Session's provider.
  expect(render("claude")).toContain("Claude / Default model / effort");
  expect(render()).toContain("Default model / effort");
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LoopComposer } from "./loop-composer";

test("shares the model control and keeps the session composer editable with sending disabled", () => {
  const client = new QueryClient();
  try {
    const render = (mode: "home" | "session") =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <LoopComposer
            mode={mode}
            projectSelect={<button type="button">Pick a project</button>}
          />
        </QueryClientProvider>,
      );
    const session = render("session");
    expect(session).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Send message"/,
    );
    expect(session).toMatch(/<textarea[^>]*aria-label="Message"/);
    expect(session).toContain('aria-label="Model and effort"');
    expect(session).not.toContain("Pick a project");
    const home = render("home");
    expect(home).toContain("Pick a project");
    expect(home).toContain('aria-label="Preview loop"');
    expect(home).toContain('aria-label="Model and effort"');
  } finally {
    client.clear();
  }
});

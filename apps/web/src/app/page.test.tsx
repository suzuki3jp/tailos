import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { Providers } from "./providers";
import HomePage from "./page";

// Exercise the route and real account error UI without loading Vinext's link/image shims.
vi.mock("@/_pages/home", () => ({
  HomePage: () => <div data-home />,
}));
vi.mock("@/app/legacy-layout", () => ({
  LegacyLayout: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

test("the home route shows home when no login error is present", async () => {
  const page = await HomePage({ searchParams: Promise.resolve({}) });
  const html = renderToStaticMarkup(<Providers>{page}</Providers>);
  expect(html).toContain("data-home");
  expect(html).not.toContain('role="alert"');
});

test.each([
  { error: "login_failed" },
  { error: ["login_failed", "access_denied"] },
])(
  "the home route preserves the account error UI for error=%j",
  async ({ error }) => {
    const page = await HomePage({ searchParams: Promise.resolve({ error }) });
    const html = renderToStaticMarkup(<Providers>{page}</Providers>);
    expect(html).toContain("アカウント");
    expect(html).toContain('role="alert"');
    expect(html).toContain("ログインできませんでした。");
    expect(html).not.toContain("data-home");
  },
);

import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./styles.css";

export const metadata = {
  title: "Tailos",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="border-b border-rule">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 px-5 py-2 sm:px-8">
            <a
              href="/"
              className="inline-flex min-h-11 items-center text-lg font-semibold"
            >
              Tailos
            </a>
            <nav
              aria-label="メインメニュー"
              className="flex gap-5 text-sm text-muted"
            >
              <a
                href="/connect"
                className="inline-flex min-h-11 items-center hover:text-ink"
              >
                ChatGPT 接続
              </a>
              <a
                href="/login"
                className="inline-flex min-h-11 items-center hover:text-ink"
              >
                アカウント
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
          <Providers>{children}</Providers>
        </main>
      </body>
    </html>
  );
}

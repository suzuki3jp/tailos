import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./styles.css";

export const metadata = {
  title: "Tailos",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      {
        url: "/favicon-dark.ico",
        sizes: "16x16 32x32 48x48",
        media: "(prefers-color-scheme: dark)",
      },
    ],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="border-b border-rule">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 px-5 py-2 sm:px-8">
            <Link href="/" className="inline-flex min-h-11 items-center">
              <Image
                src="/tailos-wordmark.png"
                alt="Tailos"
                width={88}
                height={53}
                loading="eager"
                className="h-auto w-22"
              />
            </Link>
            <nav
              aria-label="メインメニュー"
              className="flex gap-5 text-sm text-muted"
            >
              <Link
                href="/connect"
                className="inline-flex min-h-11 items-center hover:text-ink"
              >
                ChatGPT 接続
              </Link>
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center hover:text-ink"
              >
                アカウント
              </Link>
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

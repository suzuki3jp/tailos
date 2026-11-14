import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Providers } from "@/app/providers";
import "@/app/styles.css";

export const metadata = {
  title: "Tailos",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      {
        url: "/favicon.ico",
        sizes: "16x16 32x32 48x48",
        media: "(prefers-color-scheme: dark)",
      },
      {
        url: "/favicon-dark.ico",
        sizes: "16x16 32x32 48x48",
      },
    ],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="h-11 border-b border-rule">
          <div className="mx-auto flex h-full max-w-5xl items-center justify-between gap-x-6 px-5 sm:px-8">
            <Link href="/" className="inline-flex min-h-11 items-center">
              <Image
                src="/tailos-wordmark.png"
                alt="Tailos"
                width={88}
                height={53}
                loading="eager"
                className="h-9 w-auto"
              />
            </Link>
            <nav
              aria-label="メインメニュー"
              className="flex min-w-0 gap-3 overflow-x-auto whitespace-nowrap text-sm text-muted sm:gap-5"
            >
              <Link
                href="/projects"
                className="inline-flex min-h-11 items-center hover:text-ink"
              >
                Project
              </Link>
              <Link
                href="/connect"
                className="inline-flex min-h-11 items-center hover:text-ink"
              >
                ChatGPT 接続
              </Link>
              <Link
                href="/mcp"
                className="inline-flex min-h-11 items-center hover:text-ink"
              >
                MCP 接続
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

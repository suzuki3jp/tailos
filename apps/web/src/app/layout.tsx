import type { ReactNode } from "react";
import { headers } from "next/headers";
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

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // The Worker overwrites this request header with its per-response policy.
  const nonce = (await headers())
    .get("Content-Security-Policy")
    ?.match(/'nonce-([^']+)'/)?.[1];
  return (
    <html lang="ja">
      <head>{nonce && <meta property="csp-nonce" nonce={nonce} />}</head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

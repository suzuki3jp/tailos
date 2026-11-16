import type { ReactNode } from "react";
import { LegacyLayout } from "@/app/legacy-layout";

export default function ManagementLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <LegacyLayout>{children}</LegacyLayout>;
}

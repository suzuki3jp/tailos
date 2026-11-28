"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { RequestState as SharedRequestState } from "@/shared/ui/request-state";

export function RequestState(props: ComponentProps<typeof SharedRequestState>) {
  if (props.status === 401)
    return (
      <Link href="/login" className="action action-primary">
        GitHub でログイン
      </Link>
    );
  return <SharedRequestState {...props} />;
}

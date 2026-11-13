"use client";

import type { ComponentProps } from "react";
import { RequestState as SharedRequestState } from "@/shared/ui/request-state";

export function RequestState(props: ComponentProps<typeof SharedRequestState>) {
  if (props.status === 401)
    return (
      <a href="/login" className="action action-primary">
        GitHub でログイン
      </a>
    );
  return <SharedRequestState {...props} />;
}

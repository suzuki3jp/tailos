"use client";

import { useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import type { SessionRun } from "../api/queries";
import { runActivityLabel } from "../model/activity";
import { runResult } from "../model/run-result";

export function RunActivity({ run }: { run: SessionRun }) {
  const [rotated, setRotated] = useState(false);
  const { url, plan } = runResult(run.result);
  return (
    <div className="space-y-2">
      <div className="border-b border-muted-foreground/75 pb-1">
        <button
          type="button"
          aria-pressed={rotated}
          onClick={() => setRotated((value) => !value)}
          className="group inline-flex items-center gap-1.5 rounded-sm text-caption text-muted-foreground hover:text-foreground"
        >
          {runActivityLabel(run)}
          <IconChevronRight
            aria-hidden="true"
            size={16}
            className="shrink-0 transition-transform duration-200 group-aria-pressed:rotate-90 motion-reduce:transition-none"
          />
        </button>
      </div>
      {(run.errorCode || plan || url) && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {run.errorCode && (
            <span className="wrap-anywhere text-destructive">
              {run.errorCode}
            </span>
          )}
          {plan && <span>{plan}</span>}
          {url && (
            <a className="underline" href={url}>
              Open pull request
            </a>
          )}
        </div>
      )}
    </div>
  );
}

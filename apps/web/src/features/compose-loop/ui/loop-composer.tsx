"use client";

import { useId, useState, type ReactNode } from "react";
import { IconSend } from "@tabler/icons-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/shared/ui/input-group";
import { ModelEffortSelect } from "./model-effort-select";

export function LoopComposer({
  mode,
  projectSelect,
}: {
  mode: "home" | "session";
  projectSelect?: ReactNode;
}) {
  const previewSubmission = mode === "home";
  const [previewNotice, setPreviewNotice] = useState(false);
  const noticeId = useId();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (previewSubmission) setPreviewNotice(true);
      }}
    >
      <InputGroup className="min-h-35 justify-between rounded-lg bg-background">
        <InputGroupTextarea
          aria-label={previewSubmission ? "Describe your loop" : "Message"}
          aria-describedby={previewNotice ? noticeId : undefined}
          placeholder="Start loooooping..."
          onChange={() => setPreviewNotice(false)}
          required
          rows={3}
          className="min-h-0 px-3 pt-3 pb-2 text-body md:text-body"
        />
        <InputGroupAddon
          align="block-end"
          className="flex-wrap justify-end px-3 pt-0 pb-3"
        >
          {previewSubmission && <div className="mr-auto">{projectSelect}</div>}
          <div className="flex min-w-0 items-center gap-2.5">
            <ModelEffortSelect />
            <InputGroupButton
              type="submit"
              disabled={!previewSubmission}
              aria-label={previewSubmission ? "Preview loop" : "Send message"}
              className="h-5.5 w-9 rounded-md px-2 py-0 text-muted-foreground"
            >
              <IconSend aria-hidden="true" className="size-5 shrink-0" />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
      {previewNotice && (
        <p
          role="status"
          id={noticeId}
          className="mt-3 text-sm text-muted-foreground"
        >
          Loop creation is not connected yet. Your message hasn’t been sent and
          no loop has started.
        </p>
      )}
    </form>
  );
}

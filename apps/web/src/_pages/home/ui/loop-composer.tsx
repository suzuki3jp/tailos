"use client";

import { useState } from "react";
import { IconSend } from "@tabler/icons-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/shared/ui/input-group";
import { HomeProjectSelect } from "./project-select";

export function LoopComposer() {
  const [draft, setDraft] = useState("");
  const [previewNotice, setPreviewNotice] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setPreviewNotice(true);
      }}
    >
      <InputGroup className="min-h-35 justify-between rounded-lg bg-background">
        <InputGroupTextarea
          aria-label="Describe your loop"
          aria-describedby={
            previewNotice ? "composer-preview-notice" : undefined
          }
          placeholder="Start loooooping..."
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setPreviewNotice(false);
          }}
          required
          rows={3}
          className="min-h-0 px-3 pt-3 pb-2 text-body md:text-body"
        />
        <InputGroupAddon
          align="block-end"
          className="justify-between px-3 pt-0 pb-3"
        >
          <HomeProjectSelect compact />
          <InputGroupButton
            type="submit"
            aria-label="Preview loop"
            className="h-5.5 w-9 rounded-md px-2 py-0 text-muted-foreground"
          >
            <IconSend aria-hidden="true" className="size-5 shrink-0" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {previewNotice && (
        <p
          role="status"
          id="composer-preview-notice"
          className="mt-3 text-sm text-muted-foreground"
        >
          Loop creation is not connected yet. Your message hasn’t been sent and
          no loop has started.
        </p>
      )}
    </form>
  );
}

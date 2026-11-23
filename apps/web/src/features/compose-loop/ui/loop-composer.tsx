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
import {
  defaultModelEffort,
  parseModelEffort,
  type ModelEffort,
} from "../model/model-effort";

export type LoopMessage = ModelEffort & { message: string };

export function LoopComposer({
  mode,
  projectSelect,
  onSubmit,
  pending = false,
  disabled = false,
  status,
}: {
  mode: "home" | "session";
  projectSelect?: ReactNode;
  /** Sends the message; without it the composer cannot send. */
  onSubmit?: (input: LoopMessage) => void;
  pending?: boolean;
  /** Blocks sending, e.g. while no project is selected. */
  disabled?: boolean;
  /** Feedback about the last send, shown below the input. */
  status?: ReactNode;
}) {
  const [message, setMessage] = useState("");
  const [modelEffort, setModelEffort] = useState(defaultModelEffort);
  const statusId = useId();
  const home = mode === "home";
  const canSend = !!onSubmit && !disabled && !pending;
  return (
    <form
      aria-busy={pending || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        const text = message.trim();
        if (!canSend || !text) return;
        onSubmit({ message: text, ...parseModelEffort(modelEffort) });
      }}
    >
      <InputGroup className="min-h-35 justify-between rounded-lg bg-background">
        <InputGroupTextarea
          aria-label={home ? "Describe your loop" : "Message"}
          aria-describedby={status ? statusId : undefined}
          placeholder="Start loooooping..."
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          readOnly={pending}
          required
          rows={3}
          className="min-h-0 px-3 pt-3 pb-2 text-body md:text-body"
        />
        <InputGroupAddon
          align="block-end"
          className="flex-wrap justify-end px-3 pt-0 pb-3"
        >
          {home && <div className="mr-auto">{projectSelect}</div>}
          <div className="flex min-w-0 items-center gap-2.5">
            <ModelEffortSelect
              value={modelEffort}
              onValueChange={setModelEffort}
              disabled={pending}
            />
            <InputGroupButton
              type="submit"
              disabled={!canSend}
              aria-label={home ? "Start loop" : "Send message"}
              className="h-5.5 w-9 rounded-md px-2 py-0 text-muted-foreground"
            >
              <IconSend aria-hidden="true" className="size-5 shrink-0" />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
      {status && (
        <div
          role="status"
          id={statusId}
          className="mt-3 text-sm text-muted-foreground"
        >
          {status}
        </div>
      )}
    </form>
  );
}

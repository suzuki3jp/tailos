"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoopComposer, type LoopMessage } from "@/features/compose-loop";
import { sessionPath } from "@/shared/lib/session-path";
import { accountSessionsQueryOptions } from "@/entities/session";
import { startSession, StartSessionError } from "../api/start-session";
import {
  CurrentProjectSelect,
  useProjectSelection,
} from "@/features/select-project";

function failureMessage(error: unknown) {
  const status = error instanceof StartSessionError ? error.status : undefined;
  const code = error instanceof StartSessionError ? error.code : undefined;
  if (code === "codex_not_connected" || code === "claude_not_connected")
    return (
      <>
        Connect {code === "claude_not_connected" ? "Claude" : "Codex"} to start
        a loop.{" "}
        <Link href="/connect" className="underline">
          Connect
        </Link>
      </>
    );
  if (status === 401)
    return (
      <>
        Your sign-in has expired.{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </>
    );
  if (status === 404)
    return "This project is no longer available. Reload and pick another project.";
  if (status === 400) return "Check the message and model, then try again.";
  return "The loop couldn’t start. Try again.";
}

export function HomeComposer() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const queryClient = useQueryClient();
  const { selection } = useProjectSelection();
  // One ID per draft, so resending the same message returns the same Session.
  const draft = useRef<{ key: string; requestId: string } | null>(null);
  const start = useMutation({
    mutationFn: (input: Parameters<typeof startSession>[0]) =>
      startSession(input),
    onSuccess: async ({ sessionId, projectId }) => {
      await queryClient.invalidateQueries({
        queryKey: accountSessionsQueryOptions().queryKey,
      });
      router.push(sessionPath(sessionId, projectId));
    },
  });
  const submit = (input: LoopMessage) => {
    const projectId = selection.value;
    if (!projectId) return;
    const key = JSON.stringify([projectId, input]);
    if (draft.current?.key !== key)
      draft.current = { key, requestId: crypto.randomUUID() };
    start.mutate({ ...input, projectId, requestId: draft.current.requestId });
  };
  return (
    <LoopComposer
      mode="home"
      message={message}
      onMessageChange={setMessage}
      projectSelect={<CurrentProjectSelect compact />}
      onSubmit={submit}
      pending={start.isPending || start.isSuccess}
      disabled={!selection.value}
      status={
        start.isError ? (
          <>Your message wasn’t sent. {failureMessage(start.error)}</>
        ) : undefined
      }
    />
  );
}

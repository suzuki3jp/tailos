import type { AgentEngine } from "@tailos/core/models";
import { api, responseErrorCode } from "@/shared/api";

export type SendMessageInput = {
  projectId: string;
  sessionId: string;
  requestId: string;
  message: string;
  engine?: AgentEngine;
  model?: string;
  effort?: string;
};

export class SendMessageError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(`Message could not be sent (${status})`);
  }
}

/** Sends a message to the Session as its next Turn. Never retried automatically. */
export async function sendMessage(
  { projectId, sessionId, ...json }: SendMessageInput,
  client = api,
) {
  const response = await client.projects[":projectId"].sessions[
    ":id"
  ].messages.$post({
    param: {
      projectId: encodeURIComponent(projectId),
      id: encodeURIComponent(sessionId),
    },
    json,
  });
  if (response.status !== 201)
    throw new SendMessageError(
      response.status,
      await responseErrorCode(response),
    );
  return response.json();
}

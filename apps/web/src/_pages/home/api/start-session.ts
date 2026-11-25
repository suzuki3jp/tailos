import type { AgentEngine } from "@tailos/core/models";
import { api } from "@/shared/api";

export type StartSessionInput = {
  projectId: string;
  requestId: string;
  message: string;
  engine?: AgentEngine;
  model?: string;
  effort?: string;
};

export class StartSessionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(`Session could not start (${status})`);
  }
}

/** Starts a Session and its first Run. Never retried automatically. */
export async function startSession(
  { projectId, ...json }: StartSessionInput,
  client = api,
) {
  const response = await client.projects[":projectId"].sessions.$post({
    param: { projectId },
    json,
  });
  if (response.status !== 201) {
    const body: unknown = await response.json().catch(() => null);
    throw new StartSessionError(
      response.status,
      typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
        ? body.error
        : undefined,
    );
  }
  return response.json();
}

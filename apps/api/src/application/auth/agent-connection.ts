import type { AgentEngine } from "@tailos/core/models";
import { claudeConnectionId } from "@/application/auth/claude.ts";
import { codexConnectionId } from "@/application/auth/device.ts";

/** The owner's connection that a Model Provider's Turns use. */
export function agentConnectionId(engine: AgentEngine, ownerId: string) {
  return engine === "claude"
    ? claudeConnectionId(ownerId)
    : codexConnectionId(ownerId);
}

/** Whether the owner has connected the Model Provider. */
export type AgentConnected = (
  ownerId: string,
  engine: AgentEngine,
) => Promise<boolean>;

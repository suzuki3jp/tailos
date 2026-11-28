import { agentEngines, type AgentEngine } from "@tailos/core/models";

/** The Model Provider a Run ran on, when it ran on one. */
export function runEngine(engine: string | null | undefined) {
  return (agentEngines as readonly unknown[]).includes(engine)
    ? (engine as AgentEngine)
    : undefined;
}

/** A Session's Model Provider: that of its latest Run, which it keeps. */
export function sessionEngine(runs: readonly { engine?: string | null }[]) {
  return runEngine(runs.at(-1)?.engine);
}

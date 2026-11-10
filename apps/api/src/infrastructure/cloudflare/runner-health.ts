import type { Bindings } from "#api/bindings.ts";

export function checkRunnerHealth(runner: Bindings["RUNNER"]) {
  return runner?.get(runner.newUniqueId()).checkHealth();
}

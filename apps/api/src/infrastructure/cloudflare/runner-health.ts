import type { Bindings } from "../../bindings.ts";

export function checkRunnerHealth(runner: Bindings["RUNNER"]) {
  return runner?.get(runner.newUniqueId()).checkHealth();
}

import type { Bindings } from "../../bindings.ts";

export function runStarter(runner: Bindings["RUNNER"]) {
  return runner ? (id: string) => runner.getByName(id).schedule(id) : undefined;
}

import type { Bindings } from "#api/bindings.ts";

export function runStarter(runner: Bindings["RUNNER"]) {
  return runner ? (id: string) => runner.getByName(id).schedule(id) : undefined;
}

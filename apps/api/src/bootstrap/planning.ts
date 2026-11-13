import type { Bindings } from "@/bindings.ts";
import { dispatchPlanningInputs } from "@/infrastructure/d1/planning.ts";
import { runStarter } from "@/infrastructure/cloudflare/run-start.ts";

export async function processPlanningInputs(env: Bindings) {
  const ids = await dispatchPlanningInputs(env.DB);
  const schedule = runStarter(env.RUNNER);
  if (schedule) await Promise.all(ids.map((id) => schedule(id)));
}

import type { Bindings } from "@/bindings.ts";
import { dispatchSessionInbox } from "@/infrastructure/d1/session-inbox.ts";
import { runStarter } from "@/infrastructure/cloudflare/run-start.ts";

/** Starts the Turns of waiting messages whose Sessions are free. */
export async function processSessionInbox(env: Bindings) {
  const ids = await dispatchSessionInbox(env.DB);
  const schedule = runStarter(env);
  if (schedule) await Promise.all(ids.map((id) => schedule(id)));
}

import { runnerEventSchema, type RunnerEvent } from "@meguri/core/runner";
import * as v from "valibot";

export type RunArtifactsBucket = {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, contents: string): Promise<unknown>;
};

export type TerminalResult =
  | { status: "succeeded" }
  | { status: "failed"; errorCode: string };

type ArtifactRecord = {
  version: 1;
  runId: string;
  completedAt: number;
  result: TerminalResult;
  events: readonly RunnerEvent[];
};

const artifactSchema = v.strictObject({
  version: v.literal(1),
  runId: v.pipe(v.string(), v.uuid()),
  completedAt: v.pipe(v.number(), v.safeInteger()),
  result: v.variant("status", [
    v.strictObject({ status: v.literal("succeeded") }),
    v.strictObject({ status: v.literal("failed"), errorCode: v.string() }),
  ]),
  events: v.pipe(v.array(runnerEventSchema), v.maxLength(20)),
});

const key = (runId: string) => `meguri-api/v1/runs/${runId}/execution.json`;

export async function writeRunArtifacts(
  bucket: RunArtifactsBucket,
  runId: string,
  completedAt: number,
  result: TerminalResult,
  events: readonly RunnerEvent[],
) {
  const record: ArtifactRecord = {
    version: 1,
    runId,
    completedAt,
    result,
    events,
  };
  await bucket.put(key(runId), JSON.stringify(record));
}

export async function readRunArtifact(
  bucket: RunArtifactsBucket,
  runId: string,
  file: "result.json" | "events.ndjson",
  terminal: TerminalResult,
): Promise<Response | null> {
  const object = await bucket.get(key(runId));
  if (!object) return null;

  const record = v.parse(artifactSchema, JSON.parse(await object.text()));
  if (record.runId !== runId) throw new Error("Artifact run mismatch");
  const { events, ...metadata } = record;
  // The outcome in D1 is authoritative if persisting the reply failed after
  // R2 accepted the runner output.
  const result = { ...metadata, result: terminal };
  const body =
    file === "events.ndjson"
      ? events.map((event) => JSON.stringify(event) + "\n").join("")
      : JSON.stringify(result);
  return new Response(body, {
    headers: {
      "Content-Type":
        file === "events.ndjson" ? "application/x-ndjson" : "application/json",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

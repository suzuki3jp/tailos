import { readFile, readdir } from "node:fs/promises";
import type { TestContext } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

export async function createTestBindings(t: TestContext): Promise<{
  DB: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  RUN_ARTIFACTS: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
}> {
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch: () => new Response(null) }",
      compatibilityDate: "2026-10-06",
      d1Databases: ["DB"],
      r2Buckets: ["RUN_ARTIFACTS"],
    }),
  );
  t.onTestFinished(() => worker.dispose());
  const db = await worker.getD1Database("DB");
  const directory = new URL("../../../migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const migration = await readFile(new URL(file, directory), "utf8");
    await db.batch(
      migration
        .split("--> statement-breakpoint")
        .map((statement) => db.prepare(statement)),
    );
  }

  return { DB: db, RUN_ARTIFACTS: await worker.getR2Bucket("RUN_ARTIFACTS") };
}

export async function createTestDb(t: TestContext) {
  return (await createTestBindings(t)).DB;
}

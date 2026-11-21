import { readFile, readdir } from "node:fs/promises";
import type { TestContext } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

export async function createTestBindings(
  t: TestContext,
  options: {
    script?: string;
    durableObjects?: Record<string, { className: string; useSQLite: boolean }>;
    bindings?: Record<string, string>;
    migrationsThrough?: string;
    beforeMigration?: (
      db: Awaited<ReturnType<Miniflare["getD1Database"]>>,
      file: string,
    ) => Promise<void>;
  } = {},
): Promise<{
  DB: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  RUN_ARTIFACTS: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
  worker: Miniflare;
}> {
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script:
        options.script ?? "export default { fetch: () => new Response(null) }",
      durableObjects: options.durableObjects,
      bindings: options.bindings,
      compatibilityDate: "2026-10-06",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["RUN_ARTIFACTS"],
    }),
  );
  t.onTestFinished(() => worker.dispose());
  const db = await worker.getD1Database("DB");
  const directory = new URL("../../../migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter(
      (file) =>
        file.endsWith(".sql") &&
        (!options.migrationsThrough || file <= options.migrationsThrough),
    )
    .sort();
  for (const file of files) {
    await options.beforeMigration?.(db, file);
    const migration = await readFile(new URL(file, directory), "utf8");
    await db.batch(
      migration
        .split("--> statement-breakpoint")
        .map((statement) => db.prepare(statement)),
    );
  }

  return {
    DB: db,
    RUN_ARTIFACTS: await worker.getR2Bucket("RUN_ARTIFACTS"),
    worker,
  };
}

export async function createTestDb(
  t: TestContext,
): Promise<Awaited<ReturnType<Miniflare["getD1Database"]>>> {
  return (await createTestBindings(t)).DB;
}

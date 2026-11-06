import { readFile } from "node:fs/promises";
import type { TestContext } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

export async function createTestDb(t: TestContext) {
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch: () => new Response(null) }",
      compatibilityDate: "2026-10-06",
      d1Databases: ["DB"],
    }),
  );
  t.onTestFinished(() => worker.dispose());
  const db = await worker.getD1Database("DB");
  const migration = await readFile(
    new URL("../../../migrations/0000_initial.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    migration
      .split("--> statement-breakpoint")
      .map((statement) => db.prepare(statement)),
  );

  return db;
}

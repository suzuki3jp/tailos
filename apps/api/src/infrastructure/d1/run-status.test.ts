import { expect, test } from "vitest";
import { activeRunStatusSql, runStatusSql } from "./run-status.ts";
import { createTestDb } from "./testing.ts";

test("migrations enforce the canonical Run states and index the active states", async (t) => {
  const db = await createTestDb(t);
  const table = await db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'runs'",
    )
    .first<string>("sql");
  expect(table).toContain(`CHECK("runs"."status" in ${runStatusSql})`);

  const { results } = await db
    .prepare(`SELECT name, sql FROM sqlite_schema
      WHERE tbl_name = 'runs'
        AND name IN ('one_active_run_per_session', 'one_active_run_per_target', 'run_next_action')
      ORDER BY name`)
    .all<{ name: string; sql: string }>();
  expect(results.map(({ name }) => name)).toEqual([
    "one_active_run_per_session",
    "one_active_run_per_target",
    "run_next_action",
  ]);
  for (const { name, sql } of results) {
    expect(sql, name).toContain(
      `WHERE "runs"."status" in ${activeRunStatusSql}`,
    );
  }
});

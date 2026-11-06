import assert from "node:assert/strict";
import { test } from "vitest";
import { ensureD1Database } from "./provision.mjs";

const database = {
  name: "meguri",
  uuid: "fcb7056f-e824-41f1-b447-b78d1408ab63",
};

test("reuses the exact D1 database name", () => {
  assert.equal(
    ensureD1Database(database.name, (args, capture) => {
      assert.deepEqual(args, ["d1", "list", "--json"]);
      assert.equal(capture, true);
      return JSON.stringify([{ ...database, name: "meguri-dev" }, database]);
    }),
    database.uuid,
  );
});

for (const concurrent of [false, true]) {
  test(`resolves the UUID after ${concurrent ? "a concurrent" : "the first"} D1 creation`, () => {
    let created = false;
    assert.equal(
      ensureD1Database(database.name, (args) => {
        if (args[1] === "list")
          return JSON.stringify(created ? [database] : []);
        assert.deepEqual(args, [
          "d1",
          "create",
          database.name,
          "--no-update-config",
        ]);
        created = true;
        if (concurrent) throw new Error("Already exists");
      }),
      database.uuid,
    );
    assert.equal(created, true);
  });
}

test("does not create a database after a failed lookup", () => {
  assert.throws(
    () =>
      ensureD1Database(database.name, (args) => {
        assert.deepEqual(args, ["d1", "list", "--json"]);
        throw new Error("Cloudflare denied lookup");
      }),
    /Cloudflare denied lookup/,
  );
});

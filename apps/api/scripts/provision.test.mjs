import { expect, test } from "vitest";
import { ensureD1Database } from "./provision.mjs";

const database = {
  name: "meguri",
  uuid: "fcb7056f-e824-41f1-b447-b78d1408ab63",
};

test("reuses the exact D1 database name", () => {
  expect(
    ensureD1Database(database.name, (args, capture) => {
      expect(args).toStrictEqual(["d1", "list", "--json"]);
      expect(capture).toBe(true);
      return JSON.stringify([{ ...database, name: "meguri-dev" }, database]);
    }),
  ).toBe(database.uuid);
});

for (const concurrent of [false, true]) {
  test(`resolves the UUID after ${concurrent ? "a concurrent" : "the first"} D1 creation`, () => {
    let created = false;
    expect(
      ensureD1Database(database.name, (args) => {
        if (args[1] === "list")
          return JSON.stringify(created ? [database] : []);
        expect(args).toStrictEqual([
          "d1",
          "create",
          database.name,
          "--no-update-config",
        ]);
        created = true;
        if (concurrent) throw new Error("Already exists");
      }),
    ).toBe(database.uuid);
    expect(created).toBe(true);
  });
}

test("does not create a database after a failed lookup", () => {
  expect(() =>
    ensureD1Database(database.name, (args) => {
      expect(args).toStrictEqual(["d1", "list", "--json"]);
      throw new Error("Cloudflare denied lookup");
    }),
  ).toThrow(/Cloudflare denied lookup/);
});

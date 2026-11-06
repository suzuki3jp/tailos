import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});
import { ensureD1Database, ensureR2Bucket } from "./provision.mjs";

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

const bucket = { bucket_name: "meguri-run-artifacts" };
const env = {
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  CLOUDFLARE_API_TOKEN: "test-token",
};
const found = () =>
  Response.json({ success: true, result: { name: bucket.bucket_name } });
const missing = () =>
  Response.json({ errors: [{ code: 10006 }] }, { status: 404 });

test("reuses the exact R2 bucket name in the configured jurisdiction", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    (url, { headers, redirect }) => {
      assert.equal(
        url,
        "https://api.cloudflare.com/client/v4/accounts/test-account/r2/buckets/meguri-run-artifacts",
      );
      assert.equal(headers.Authorization, "Bearer test-token");
      assert.equal(headers["cf-r2-jurisdiction"], "eu");
      assert.equal(redirect, "error");
      return Promise.resolve(found());
    },
  );
  await ensureR2Bucket({ ...bucket, jurisdiction: "eu" }, env, () => {
    assert.fail("Existing bucket must be reused");
  });
});

for (const concurrent of [false, true]) {
  test(`accepts ${concurrent ? "a concurrent" : "the first"} R2 creation`, async () => {
    let created = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(created ? found() : missing()),
    );
    await ensureR2Bucket({ ...bucket, jurisdiction: "eu" }, env, (args) => {
      assert.deepEqual(args, [
        "r2",
        "bucket",
        "create",
        bucket.bucket_name,
        "--no-update-config",
        "--jurisdiction",
        "eu",
      ]);
      created = true;
      if (concurrent) throw new Error("Already exists");
    });
    assert.equal(created, true);
  });
}

for (const status of [403, 404, 500]) {
  test(`does not create an R2 bucket after an unexpected HTTP ${status}`, async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(Response.json({ errors: [{ code: 1000 }] }, { status })),
    );
    await assert.rejects(
      ensureR2Bucket(bucket, env, () => assert.fail("Unexpected creation")),
      /Could not look up R2 bucket/,
    );
  });
}

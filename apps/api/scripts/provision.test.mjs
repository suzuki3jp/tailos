import { expect, afterEach, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});
import { ensureD1Database, ensureR2Bucket } from "./provision.mjs";

const database = {
  name: "tailos",
  uuid: "fcb7056f-e824-41f1-b447-b78d1408ab63",
};

test("reuses the exact D1 database name", () => {
  expect(
    ensureD1Database(database.name, (args, capture) => {
      expect(args).toStrictEqual(["d1", "list", "--json"]);
      expect(capture).toBe(true);
      return JSON.stringify([{ ...database, name: "tailos-dev" }, database]);
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
          "--location=apac",
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

const bucket = { bucket_name: "tailos-run-artifacts" };
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
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/test-account/r2/buckets/tailos-run-artifacts",
      );
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["cf-r2-jurisdiction"]).toBe("eu");
      expect(redirect).toBe("error");
      return Promise.resolve(found());
    },
  );
  await ensureR2Bucket({ ...bucket, jurisdiction: "eu" }, env, () => {
    expect.fail("Existing bucket must be reused");
  });
});

for (const concurrent of [false, true]) {
  test(`accepts ${concurrent ? "a concurrent" : "the first"} R2 creation`, async () => {
    let created = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(created ? found() : missing()),
    );
    await ensureR2Bucket({ ...bucket, jurisdiction: "eu" }, env, (args) => {
      expect(args).toStrictEqual([
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
    expect(created).toBe(true);
  });
}

for (const status of [403, 404, 500]) {
  test(`does not create an R2 bucket after an unexpected HTTP ${status}`, async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(Response.json({ errors: [{ code: 1000 }] }, { status })),
    );
    await expect(
      ensureR2Bucket(bucket, env, () => expect.fail("Unexpected creation")),
    ).rejects.toThrow(/Could not look up R2 bucket/);
  });
}

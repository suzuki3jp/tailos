import assert from "node:assert/strict";
import { test } from "vitest";
import { seal, unseal } from "./sealed-store.ts";

test("seals credentials to their intended connection and rejects a different key", async () => {
  const key = Buffer.alloc(32, 4).toString("base64");
  const otherKey = Buffer.alloc(32, 5).toString("base64");
  const value = { refreshToken: "private-refresh-token" };
  const encrypted = await seal(value, key, "connection-a");
  assert.doesNotMatch(JSON.stringify(encrypted), /private-refresh-token/);
  assert.deepEqual(await unseal(encrypted, key, "connection-a"), value);
  await assert.rejects(unseal(encrypted, key, "connection-b"));
  await assert.rejects(unseal(encrypted, otherKey, "connection-a"));
});

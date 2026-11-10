import { expect, test } from "vitest";
import { seal, unseal } from "#api/infrastructure/auth/sealed-store.ts";

test("seals credentials to their intended connection and rejects a different key", async () => {
  const key = Buffer.alloc(32, 4).toString("base64");
  const otherKey = Buffer.alloc(32, 5).toString("base64");
  const value = { refreshToken: "private-refresh-token" };
  const encrypted = await seal(value, key, "connection-a");
  expect(JSON.stringify(encrypted)).not.toMatch(/private-refresh-token/);
  expect(await unseal(encrypted, key, "connection-a")).toStrictEqual(value);
  await expect(unseal(encrypted, key, "connection-b")).rejects.toThrow();
  await expect(unseal(encrypted, otherKey, "connection-a")).rejects.toThrow();
});

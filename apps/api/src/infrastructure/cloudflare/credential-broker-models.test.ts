import { expect, test, vi } from "vitest";
import type { CodexAccess } from "@tailos/core/runner";
import { CredentialBroker } from "@/infrastructure/cloudflare/credential-broker.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));

function createBroker(
  lookup: () => Promise<{ model: string; efforts: string[] }[] | null>,
) {
  const catalog = vi.fn(lookup);
  const runner = {
    newUniqueId: vi.fn(() => "isolated-runner"),
    get: vi.fn(() => ({ codexModels: catalog })),
  };
  const broker = new CredentialBroker(
    {
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>) =>
        callback(),
      storage: { async delete() {}, async deleteAlarm() {} },
    } as unknown as ConstructorParameters<typeof CredentialBroker>[0],
    // This test exercises the catalog coordination, not Cloudflare namespace construction.
    { RUNNER: runner } as unknown as ConstructorParameters<
      typeof CredentialBroker
    >[1],
  );
  const access: CodexAccess = {
    accessToken: "short-lived-access",
    accountId: "account",
    accessVersion: crypto.randomUUID(),
    connectionVersion: crypto.randomUUID(),
  };
  const issueAccess = vi.spyOn(broker, "issueAccess").mockResolvedValue(access);
  return { broker, catalog, access, issueAccess };
}

test("concurrent catalog requests share one Runner lookup for the same connection", async () => {
  let finish = (_models: { model: string; efforts: string[] }[]) => {};
  const pending = new Promise<{ model: string; efforts: string[] }[]>(
    (resolve) => {
      finish = resolve;
    },
  );
  const { broker, catalog } = createBroker(() => pending);
  const first = broker.codexModels();
  const second = broker.codexModels();
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
  const models = [{ model: "model", efforts: ["high"] }];
  finish(models);
  expect(await first).toEqual(models);
  expect(await second).toEqual(models);
});

test("failed catalog lookups are retried and disconnected credentials never use an in-flight result", async () => {
  const { broker, catalog, issueAccess } = createBroker(async () => null);
  expect(await broker.codexModels()).toBeNull();
  expect(await broker.codexModels()).toBeNull();
  expect(catalog).toHaveBeenCalledTimes(2);
  catalog.mockRejectedValueOnce(new Error("Unavailable"));
  await expect(broker.codexModels()).rejects.toThrow("Unavailable");
  expect(await broker.codexModels()).toBeNull();
  expect(catalog).toHaveBeenCalledTimes(4);
  issueAccess.mockResolvedValue(null);
  expect(await broker.codexModels()).toBeNull();
  expect(catalog).toHaveBeenCalledTimes(4);
});

test("a new connection does not join the previous connection's lookup", async () => {
  let finish = (_models: { model: string; efforts: string[] }[]) => {};
  const pending = new Promise<{ model: string; efforts: string[] }[]>(
    (resolve) => {
      finish = resolve;
    },
  );
  const { broker, catalog, access, issueAccess } = createBroker(() => pending);
  const first = broker.codexModels();
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
  issueAccess.mockResolvedValue({
    ...access,
    connectionVersion: crypto.randomUUID(),
  });
  catalog.mockResolvedValueOnce([{ model: "new-model", efforts: ["high"] }]);
  expect(await broker.codexModels()).toEqual([
    { model: "new-model", efforts: ["high"] },
  ]);
  finish([{ model: "old-model", efforts: ["high"] }]);
  expect(await first).toEqual([{ model: "old-model", efforts: ["high"] }]);
  expect(catalog).toHaveBeenCalledTimes(2);
  expect(await broker.codexModels()).toEqual([
    { model: "new-model", efforts: ["high"] },
  ]);
  expect(catalog).toHaveBeenCalledTimes(2);
});

test("successful catalogs expire five minutes after completion without extending expiry on reads", async (t) => {
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  t.onTestFinished(() => clock.mockRestore());
  let finish = (_models: { model: string; efforts: string[] }[]) => {};
  const pending = new Promise<{ model: string; efforts: string[] }[]>(
    (resolve) => {
      finish = resolve;
    },
  );
  const { broker, catalog } = createBroker(() => pending);
  const models = [{ model: "model", efforts: ["high"] }];
  const request = broker.codexModels();
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
  now = 60_000;
  finish(models);
  expect(await request).toEqual(models);
  now += 5 * 60_000 - 1;
  expect(await broker.codexModels()).toEqual(models);
  expect(catalog).toHaveBeenCalledTimes(1);
  now += 1;
  const updated = [{ model: "updated", efforts: ["medium"] }];
  catalog.mockResolvedValueOnce(updated);
  expect(await broker.codexModels()).toEqual(updated);
  expect(catalog).toHaveBeenCalledTimes(2);
});

test("an empty catalog is retried rather than cached", async () => {
  const { broker, catalog } = createBroker(async () => []);
  expect(await broker.codexModels()).toEqual([]);
  const models = [{ model: "model", efforts: ["high"] }];
  catalog.mockResolvedValueOnce(models);
  expect(await broker.codexModels()).toEqual(models);
  expect(await broker.codexModels()).toEqual(models);
  expect(catalog).toHaveBeenCalledTimes(2);
});

test("disconnect clears a successful catalog and late results cannot repopulate it", async () => {
  const models = [{ model: "model", efforts: ["high"] }];
  const { broker, catalog } = createBroker(async () => models);
  expect(await broker.codexModels()).toEqual(models);
  await broker.disconnect();
  let finish = (_models: { model: string; efforts: string[] }[]) => {};
  const pending = new Promise<{ model: string; efforts: string[] }[]>(
    (resolve) => {
      finish = resolve;
    },
  );
  catalog.mockReturnValueOnce(pending);
  const old = broker.codexModels();
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
  await broker.disconnect();
  finish([{ model: "old", efforts: ["low"] }]);
  await old;
  expect(await broker.codexModels()).toEqual(models);
  expect(catalog).toHaveBeenCalledTimes(3);
});

test("a missing or changed connection never reuses the previous cached catalog", async () => {
  const models = [{ model: "model", efforts: ["high"] }];
  const { broker, catalog, access, issueAccess } = createBroker(
    async () => models,
  );
  expect(await broker.codexModels()).toEqual(models);
  issueAccess.mockResolvedValue(null);
  expect(await broker.codexModels()).toBeNull();
  expect(catalog).toHaveBeenCalledTimes(1);
  issueAccess.mockResolvedValue(access);
  expect(await broker.codexModels()).toEqual(models);
  expect(catalog).toHaveBeenCalledTimes(2);
  issueAccess.mockResolvedValue({
    ...access,
    connectionVersion: crypto.randomUUID(),
  });
  const updated = [{ model: "new", efforts: ["low"] }];
  catalog.mockResolvedValueOnce(updated);
  expect(await broker.codexModels()).toEqual(updated);
  expect(await broker.codexModels()).toEqual(updated);
  expect(catalog).toHaveBeenCalledTimes(3);
});

test("different owners keep independent catalogs", async () => {
  const first = createBroker(async () => [
    { model: "first", efforts: ["high"] },
  ]);
  const second = createBroker(async () => [
    { model: "second", efforts: ["low"] },
  ]);
  // Even identical connection IDs cannot share memory between owner brokers.
  second.issueAccess.mockResolvedValue(first.access);
  for (let n = 0; n < 2; n++) {
    expect(await first.broker.codexModels()).toEqual([
      { model: "first", efforts: ["high"] },
    ]);
    expect(await second.broker.codexModels()).toEqual([
      { model: "second", efforts: ["low"] },
    ]);
  }
  expect(first.catalog).toHaveBeenCalledTimes(1);
  expect(second.catalog).toHaveBeenCalledTimes(1);
});
